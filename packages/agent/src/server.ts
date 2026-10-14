import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream,
  type Agent, type AuthenticateRequest, type CancelNotification, type CloseSessionRequest, type InitializeRequest, type InitializeResponse,
  type LoadSessionRequest, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse
} from '@agentclientprotocol/sdk'
import type { Provider } from '@earendil-works/pi-ai'
import { init, observe, type FlueEvent, type McpConnectionDefinition } from '@flue/runtime'
import type { Flue } from '@flue/runtime/node'
import { IronflowAgent, forgetSandbox } from './agent.js'
import { providerEnvFor, resolveCredential } from './auth.js'
import { bridgedConnection, claimsIronflowNamespace, degradedNotice, engineCheck, engineDownNotice, ironflowConnection, mcpTarget, probeMcp, type BridgeStart, type Target, type startBridge } from './mcp.js'
import { resolveModel } from './models.js'
import { PermissionGate } from './permissions.js'
import { noteToolArgs, startRuntime } from './runtime.js'
import { sessions, type SessionContext } from './sessions.js'
import { bundledSkillsRoot, loadSkills } from './skills.js'
import { Transcript } from './transcript.js'
import { promptToMessage, toSessionUpdate } from './translate.js'

// Logs carry no prompt text and no keys: stdout is the ACP channel and stderr lands in editor logs.
const log = (m: string): void => { process.stderr.write(`[ironflow-agent] ${m}\n`) }

const AUTH_HINT = 'No model API key. Run `npx @ironflow/agent login`, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY in the agent config.'

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

const SLOW_PROBE_MS = 1_000
const PROBE_BACKOFF_MS = 60_000

interface Turn {
  cancelled: boolean
  handle: { abort(): Promise<void> } | null
}

export class IronflowAcpAgent implements Agent {
  private caps = { readTextFile: false, writeTextFile: false, terminal: false }
  private terminalAuth = false
  private readonly live = new Map<string, Turn>()
  private readonly transcripts = new Map<string, Transcript>()
  private readonly tails = new Map<string, Promise<void>>()
  // Per-session provider key, only to redact it from error text sent to the host.
  private readonly keys = new Map<string, string>()
  // After a probe that hung (dropped packets), skip re-probing until this time.
  private probeRetryAt = 0
  // The notice from the last connect that mounted nothing, reused while probes back off.
  private lastNotice: string | null = null
  // One `ironflow mcp` child per workspace, shared by its sessions and kept until dispose().
  // Each entry chains on the one before it, so concurrent callers never start two children.
  private readonly bridges = new Map<string, Promise<BridgeStart>>()
  private disposed = false

  // In the CLI, opts.env is process.env, and setup() writes the resolved key into process.env for
  // pi-ai. Reading credentials from a snapshot keeps that write from beating a newer file key
  // (after `login` or `logout`), while a key the user set in the agent config still wins.
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly conn: AgentSideConnection, private readonly opts: { home: string; env: NodeJS.ProcessEnv; fetchFn?: typeof fetch; bridge?: typeof startBridge }) {
    this.env = { ...opts.env }
  }

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    this.caps = {
      readTextFile: Boolean(req.clientCapabilities?.fs?.readTextFile),
      writeTextFile: Boolean(req.clientCapabilities?.fs?.writeTextFile),
      terminal: Boolean(req.clientCapabilities?.terminal)
    }
    // Both are explicit client opt-ins. The ACP registry checker (verify_agents.py --auth-check)
    // sends the _meta form, not auth.terminal.
    this.terminalAuth = req.clientCapabilities?.auth?.terminal === true || req.clientCapabilities?._meta?.['terminal-auth'] === true
    if (!this.caps.writeTextFile || !this.caps.terminal) log('client lacks fs or terminal capability; using the local route')
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: false, audio: false },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { close: {} }
      },
      // ACP: advertise a terminal method only to a client that enabled terminal authentication.
      authMethods: this.terminalAuth
        ? [{ id: 'login', name: 'Log in with an API key', description: 'Store a model provider API key for the Ironflow agent.', type: 'terminal', args: ['login'] }]
        : [],
      agentInfo: { name: 'ironflow-agent', title: 'Ironflow', version: await packageVersion() }
    }
  }

  async authenticate(req: AuthenticateRequest): Promise<Record<string, never>> {
    // Clients must not send a terminal method here (ACP spec); the method runs in a terminal.
    throw RequestError.invalidParams({ methodId: req.methodId }, 'the login method runs in a terminal')
  }

  private async setup(sessionId: string, cwd: string, mcpServers: NewSessionRequest['mcpServers']): Promise<void> {
    let transcript: Transcript
    try {
      transcript = new Transcript(this.opts.home, sessionId)
    } catch {
      throw RequestError.invalidParams({ sessionId }, 'invalid session id')
    }
    const cred = await resolveCredential(this.env, this.opts.home)
    if (!cred.ok) {
      throw RequestError.authRequired({ reason: cred.reason }, cred.reason === 'file-mode'
        ? `${this.opts.home}/credentials.json is readable by other users. Run \`chmod 600\` on it or log in again.`
        : AUTH_HINT)
    }
    Object.assign(process.env, providerEnvFor(cred.credential))
    // Checked again after the awaits below; this copy only saves a child and a probe on a refusal.
    this.assertFree(sessionId)
    const ironflow = Date.now() < this.probeRetryAt && this.lastNotice
      ? { mcp: null, notice: this.lastNotice, mcpRetry: true }
      : await this.connectIronflow(sessionId, cwd)
    const extraMcp: McpConnectionDefinition[] = []
    for (const s of mcpServers) {
      if (!('url' in s) || (s as { type?: string }).type !== 'http') {
        log(`skipping MCP server ${s.name}: only HTTP MCP servers are supported`)
      } else if (claimsIronflowNamespace(s.name)) {
        log(`skipping MCP server ${s.name}: its tools would be named like the Ironflow tools`)
      } else {
        extraMcp.push({ name: s.name, url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) })
      }
    }
    // Everything below is synchronous, so a reload of a live id swaps its state in one step.
    // `sessions` and the Flue instance are process-wide, so two connections cannot share an id.
    this.assertFree(sessionId)
    this.release(sessionId)
    this.keys.set(sessionId, cred.credential.apiKey)
    sessions.set(sessionId, {
      id: sessionId, cwd, home: this.opts.home, client: this.conn, caps: this.caps,
      gate: new PermissionGate(this.conn, sessionId, { cwd, home: this.opts.home }),
      model: resolveModel(this.env, cred.credential.provider),
      ...ironflow,
      extraMcp
    })
    this.transcripts.set(sessionId, transcript)
  }

  private assertFree(sessionId: string): void {
    if (sessions.has(sessionId) && !this.owns(sessionId)) throw RequestError.invalidRequest({ sessionId }, 'this session is open in another connection')
    if (this.live.has(sessionId)) throw RequestError.invalidRequest({ sessionId }, 'a turn is already running in this session')
  }

  /**
   * The `ironflow mcp` child first, because it works under `serve --dev`, where the server refuses
   * remote MCP. Remote HTTP is the fallback for a machine without `ironflow` on PATH. Both run at
   * once, so a slow bridge and a slow server cost one timeout, not two.
   */
  private async connectIronflow(sessionId: string, cwd: string): Promise<Pick<SessionContext, 'mcp' | 'notice' | 'mcpRetry'>> {
    const target = mcpTarget(this.env)
    const t0 = Date.now()
    const [bridged, remote] = await Promise.all([this.probeBridge(cwd), probeMcp(target, this.opts.fetchFn)])
    const route = async (): Promise<Target | string> => {
      const b = await this.bridgeFor(sessions.get(sessionId)?.cwd ?? cwd)
      return b.ok ? b.bridge.target : b.detail
    }
    let found: Pick<SessionContext, 'mcp' | 'notice' | 'mcpRetry'>
    if (bridged.ok && !bridged.engineDown) found = { mcp: bridgedConnection(bridged.tools, route, this.opts.fetchFn), notice: null, mcpRetry: false }
    else if (remote.ok) found = { mcp: ironflowConnection(target, remote.tools), notice: null, mcpRetry: false }
    // Mounted anyway: the model often starts the engine itself, and the next call then works.
    else if (bridged.ok) found = { mcp: bridgedConnection(bridged.tools, route, this.opts.fetchFn), notice: engineDownNotice(bridged.engineDown!), mcpRetry: true }
    else found = { mcp: null, notice: degradedNotice(target, remote, this.opts.bridge ? bridged.detail : undefined), mcpRetry: true }
    if (found.mcpRetry && Date.now() - t0 > SLOW_PROBE_MS) this.probeRetryAt = Date.now() + PROBE_BACKOFF_MS
    if (!found.mcp) this.lastNotice = found.notice
    return found
  }

  private async probeBridge(cwd: string): Promise<{ ok: true; tools: string[]; engineDown: string | null } | { ok: false; detail: string }> {
    if (!this.opts.bridge) return { ok: false, detail: 'disabled' }
    const started = await this.bridgeFor(cwd)
    if (!started.ok) return started
    const probe = await probeMcp(started.bridge.target, this.opts.fetchFn)
    if (!probe.ok) {
      // bridgeFor starts a new child in place of a stopped one.
      started.bridge.stop()
      return { ok: false, detail: `it started but did not answer tools/list (${probe.detail})` }
    }
    const engineDown = await engineCheck(started.bridge.target, this.opts.fetchFn)
    // The child resolves the engine once, at spawn. Replace it on next use, so an engine started
    // later, maybe on another port, is found.
    if (engineDown) started.bridge.stop()
    return { ok: true, tools: probe.tools, engineDown }
  }

  /** The live child for `cwd`, started or restarted as needed. */
  private bridgeFor(cwd: string): Promise<BridgeStart> {
    const start = this.opts.bridge
    if (!start) return Promise.resolve({ ok: false, detail: 'disabled' })
    const next = (this.bridges.get(cwd) ?? Promise.resolve(null)).then(async (prev): Promise<BridgeStart> => {
      if (prev?.ok && prev.bridge.alive()) return prev
      if (this.disposed) return { ok: false, detail: 'the agent is stopping' }
      const started = await start(this.env, { cwd })
      // dispose() ran while the child was starting and could not see it.
      if (this.disposed && started.ok) { started.bridge.stop(); return { ok: false, detail: 'the agent is stopping' } }
      return started
    })
    this.bridges.set(cwd, next)
    return next
  }

  /** Drops every per-session entry, so a reload, a close or a stop leaves nothing behind. */
  private release(sessionId: string): void {
    if (!this.owns(sessionId)) return
    sessions.delete(sessionId)
    this.transcripts.delete(sessionId)
    this.tails.delete(sessionId)
    this.keys.delete(sessionId)
    forgetSandbox(sessionId)
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID().replaceAll('-', '')
    await this.setup(sessionId, req.cwd, req.mcpServers)
    return { sessionId }
  }

  async loadSession(req: LoadSessionRequest): Promise<Record<string, never>> {
    await this.setup(req.sessionId, req.cwd, req.mcpServers)
    for await (const update of this.transcripts.get(req.sessionId)!.replay()) {
      await this.conn.sessionUpdate({ sessionId: req.sessionId, update })
    }
    return {}
  }

  async closeSession(req: CloseSessionRequest): Promise<Record<string, never>> {
    await this.cancel(req)
    this.release(req.sessionId)
    return {}
  }

  /** Process stop: end every live turn and forget every session this connection holds. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.transcripts.keys()]) {
      await this.cancel({ sessionId: id })
      this.release(id)
    }
    const pending = [...this.bridges.values()]
    this.bridges.clear()
    for (const b of await Promise.all(pending)) if (b.ok) b.bridge.stop()
  }

  /**
   * Called by the process-wide observer for events of this session. Flue does not await
   * subscribers in order, so each session's updates go through one promise chain: chunks keep
   * their order, and prompt() awaits the chain before it returns a stop reason.
   */
  onEvent(sessionId: string, event: FlueEvent): void {
    const s = sessions.get(sessionId)
    if (!s) return
    if (event.type === 'tool_start') noteToolArgs(event.toolCallId, event.toolName, event.args)
    const update = toSessionUpdate(event, s.cwd)
    if (!update) return
    const prev = this.tails.get(sessionId) ?? Promise.resolve()
    this.tails.set(sessionId, prev.then(async () => {
      await this.transcripts.get(sessionId)?.append(update).catch((err: Error) => log(`transcript for ${sessionId} failed: ${err.message}`))
      await this.conn.sessionUpdate({ sessionId, update })
    }).catch((err: Error) => log(`update for ${sessionId} failed: ${err.message}`)))
  }

  owns(sessionId: string): boolean {
    return this.transcripts.has(sessionId)
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const id = req.sessionId
    const s = sessions.get(id)
    const transcript = this.transcripts.get(id)
    if (!s || !transcript) throw RequestError.invalidParams({ sessionId: id }, 'unknown session')
    if (this.live.has(id)) throw RequestError.invalidRequest({ sessionId: id }, 'a turn is already running in this session')
    // Claim the session before the first await, or two prompts sent back to back both pass the check.
    const turn: Turn = { cancelled: false, handle: null }
    this.live.set(id, turn)
    const key = this.keys.get(id)
    try {
      const message = promptToMessage(req.prompt, s.cwd)
      await transcript.append({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message } })
      // A session that started with no server would otherwise never get MCP tools, so connect
      // again before each prompt until the engine answers. A retry can start an `ironflow mcp`
      // child; a slow one backs off. It stays out of the agent function: that runs once per model turn.
      if (s.mcpRetry && Date.now() >= this.probeRetryAt) {
        const found = await this.connectIronflow(id, s.cwd)
        // Flue keeps the first connection it made under this name, so a mounted one stays.
        s.mcp ??= found.mcp
        s.mcpRetry = found.mcpRetry
        if (!found.mcpRetry) s.notice = null
      }
      if (turn.cancelled) return { stopReason: 'cancelled' }
      const handle = init(IronflowAgent, { id })
      turn.handle = handle
      const submission = await handle.dispatch(message)
      // cancel() ran while dispatch was in flight and found nothing to abort yet.
      if (turn.cancelled) await handle.abort()
      await handle.read(submission)
      await this.tails.get(id)
      // Rule: once read() settles or throws, a set cancel flag wins.
      if (turn.cancelled) return { stopReason: 'cancelled' }
      s.notice = null
      return { stopReason: 'end_turn' }
    } catch (e) {
      await this.tails.get(id)
      if (turn.cancelled) return { stopReason: 'cancelled' }
      const raw = (e as Error).message
      const msg = key ? raw.replaceAll(key, '***') : raw
      if (/\b401\b|invalid.*api key|authentication/i.test(msg)) throw RequestError.authRequired({}, `The provider rejected the API key. ${AUTH_HINT}`)
      throw RequestError.internalError({}, msg)
    } finally {
      this.live.delete(id)
    }
  }

  async cancel(n: CancelNotification): Promise<void> {
    const turn = this.live.get(n.sessionId)
    if (turn) turn.cancelled = true
    // Abort first: if the open permission prompt resolved first, its denied tool result would
    // start one more model call.
    const aborting = turn?.handle?.abort()
    if (this.owns(n.sessionId)) sessions.get(n.sessionId)?.gate.cancelPending()
    await aborting
  }
}

let runtime: { flue: Flue; refs: number } | null = null
const agents = new Set<IronflowAcpAgent>()
let unobserve: (() => void) | null = null

export async function serve(opts: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array>; home: string; env: NodeJS.ProcessEnv; providers?: Provider[]; inMemory?: boolean; fetchFn?: typeof fetch; bridge?: typeof startBridge }): Promise<{ connection: AgentSideConnection; agent: IronflowAcpAgent; stop(): Promise<void> }> {
  if (!runtime) {
    // Built packages carry the skills in dist/skills; a run from source falls back to the repo's copy.
    const skills = await loadSkills(bundledSkillsRoot()).catch(async () => loadSkills(join(dirname(fileURLToPath(import.meta.url)), '../../../../.agents/skills')))
    runtime = { flue: await startRuntime({ home: opts.home, skills, ...(opts.providers ? { providers: opts.providers } : {}), ...(opts.inMemory ? { inMemory: true } : {}) }), refs: 0 }
    unobserve = observe((event, ctx) => {
      for (const a of agents) if (a.owns(ctx.id)) a.onEvent(ctx.id, event)
    })
  }
  runtime.refs++
  let agent!: IronflowAcpAgent
  const connection = new AgentSideConnection((conn) => (agent = new IronflowAcpAgent(conn, opts)), ndJsonStream(opts.output, opts.input))
  agents.add(agent)
  let stopped = false
  return {
    connection,
    agent,
    async stop() {
      if (stopped) return
      stopped = true
      agents.delete(agent)
      await agent.dispose()
      if (runtime && --runtime.refs === 0) {
        unobserve?.(); unobserve = null
        await runtime.flue.stop()
        runtime = null
      }
    }
  }
}
