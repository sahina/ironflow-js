import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpConnectionDefinition } from '@flue/runtime'
import { IRONFLOW_ASK_TOOLS, IRONFLOW_MCP_SERVER, IRONFLOW_READ_TOOLS } from './permissions.js'

// Placeholder when IRONFLOW_API_KEY is unset. `serve --dev` does not mount /api/v1/mcp, so the
// probe reports 'disabled' there; against a server that does mount it, this token is rejected.
export const DEV_TOKEN = 'ironflow-dev'
const ALLOWLIST: readonly string[] = [...IRONFLOW_READ_TOOLS, ...IRONFLOW_ASK_TOOLS]

export type Target = { url: string; token: string }

export function mcpTarget(env: NodeJS.ProcessEnv): Target {
  const base = (env.IRONFLOW_SERVER_URL?.trim() || 'http://localhost:9123').replace(/\/+$/, '')
  return { url: `${base}/api/v1/mcp`, token: env.IRONFLOW_API_KEY || DEV_TOKEN }
}

export interface Bridge {
  target: Target
  /** False once the child has exited or been stopped. */
  alive(): boolean
  /** Kills the child and removes its temp dir. Synchronous, so it also works in an exit hook. */
  stop(): void
}

export type BridgeStart = { ok: true; bridge: Bridge } | { ok: false; detail: string }

// A Go child that has not bound in this long is not coming up.
const BRIDGE_TIMEOUT_MS = 5_000
// The child gets HOME for key discovery and IRONFLOW_* for the server and key. Model-provider keys
// in the agent's env stay out of it.
const CHILD_ENV = /^(IRONFLOW_|PATH$|HOME$|USERPROFILE$|SYSTEMROOT$|TMPDIR$|TEMP$|TMP$)/
const STDERR_TAIL = 500

const bridges = new Set<Bridge>()
let exitHooked = false

/**
 * Starts `ironflow mcp` in loopback streamable-HTTP mode, which `serve --dev` allows because the
 * child, not the engine, speaks MCP and calls the engine's ordinary API with the caller's key.
 * Flue has no stdio transport, and this mode needs no shim. It is stateless JSON on /mcp
 * (internal/mcp/server.go), so probeMcp works on it unchanged. `--allow-writes` registers the
 * write tools; the permission gate still asks before each one. `--static-only` skips the
 * application tools, which ALLOWLIST drops anyway, and the blocking engine fetch before the bind.
 * The child runs in `cwd`, so engine discovery (`.ironflow/engine.json`) finds the workspace's
 * engine. It holds a stdin pipe and exits when that closes, so it dies with the agent, even on
 * SIGKILL. A binary older than IRONFLOW_MCP_EXIT_ON_STDIN_CLOSE ignores it and lives on.
 * Never rejects: every failure is `{ ok: false }`, so the caller can fall back.
 */
export async function startBridge(env: NodeJS.ProcessEnv, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<BridgeStart> {
  let dir: string
  try {
    dir = await mkdtemp(join(tmpdir(), 'ifbridge-'))
  } catch (e) {
    return { ok: false, detail: `no temp dir for its port file: ${(e as Error).message}` }
  }
  const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
  const portFile = join(dir, 'port.json')
  const token = randomBytes(24).toString('hex')
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => CHILD_ENV.test(k) && v !== undefined))
  let child: ChildProcess
  try {
    child = spawn('ironflow', ['mcp', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', '0', '--port-file', portFile, '--allow-writes', '--static-only'], {
      env: { ...childEnv, IRONFLOW_MCP_BEARER_TOKEN: token, IRONFLOW_MCP_EXIT_ON_STDIN_CLOSE: '1' },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: ['pipe', 'ignore', 'pipe']
    })
  } catch (e) {
    cleanup()
    return { ok: false, detail: (e as Error).message }
  }
  let failure: string | null = null
  let exited = false
  let stopped = false
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-STDERR_TAIL) })
  // The agent never writes to the pipe; an EPIPE after the child exits is not an error.
  child.stdin?.on('error', () => {})
  child.once('error', (e: NodeJS.ErrnoException) => {
    failure = e.code === 'ENOENT' ? '`ironflow` is not on PATH' : e.message
  })
  child.once('exit', (code, signal) => {
    exited = true
    const tail = stderr.trim()
    failure ??= `ironflow mcp exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ''}`
  })
  const bridge: Bridge = {
    target: { url: '', token },
    // `stopped` first: exit fires later, and a caller must not reuse a child it just stopped.
    alive: () => !stopped && !exited && child.exitCode === null && child.signalCode === null,
    stop() { stopped = true; bridges.delete(bridge); child.kill(); cleanup() }
  }
  // Tracked from the spawn on, so an exit during the port poll still kills it.
  bridges.add(bridge)
  if (!exitHooked) { exitHooked = true; process.on('exit', () => { for (const b of bridges) b.stop() }) }

  const deadline = Date.now() + (opts.timeoutMs ?? BRIDGE_TIMEOUT_MS)
  for (;;) {
    if (failure) { bridge.stop(); return { ok: false, detail: failure } }
    const port = await readPort(portFile)
    if (port) { bridge.target.url = `http://127.0.0.1:${port}/mcp`; return { ok: true, bridge } }
    if (Date.now() >= deadline) { bridge.stop(); return { ok: false, detail: 'ironflow mcp did not report its port in time' } }
    await new Promise((r) => setTimeout(r, 25))
  }
}

// Go's os.WriteFile truncates and then writes, so a poll can read an empty or partial file:
// that is "not yet", not a failure.
async function readPort(path: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await readFile(path, 'utf8')) as { http_port?: number }).http_port
  } catch {
    return undefined
  }
}

export type McpProbe =
  | { ok: true; tools: string[] }
  | { ok: false; reason: 'unreachable' | 'unauthorized' | 'disabled'; detail: string }

/**
 * One tools/list round trip, so the Flue allowlist never names a tool this server lacks.
 * The engine's remote MCP handler is stateless and answers plain JSON (internal/mcp/remote.go),
 * so no initialize handshake or session id is needed.
 */
export async function probeMcp(target: Target, fetchFn: typeof fetch = fetch): Promise<McpProbe> {
  try {
    const res = await fetchFn(target.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(5_000)
    })
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', detail: String(res.status) }
    // A server without remote MCP answers its usual JSON 404 for the unknown route.
    if (res.status === 404) return { ok: false, reason: 'disabled', detail: 'HTTP 404' }
    if (!res.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` }
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } }
    if (!Array.isArray(body.result?.tools)) return { ok: false, reason: 'unreachable', detail: 'not a tools/list result' }
    return { ok: true, tools: body.result.tools.map((t) => t.name) }
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: (e as Error).message }
  }
}

/**
 * tools/list on the child answers from its static registry and never calls the engine, so this
 * runs one authenticated read through it. Returns null when the engine answered, else the reason.
 */
export async function engineCheck(target: Target, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(target.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ironflow_list_functions', arguments: { limit: 1 } } }),
      signal: AbortSignal.timeout(5_000)
    })
    if (!res.ok) return `HTTP ${res.status}`
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } }
    if (body.error) return body.error.message ?? 'JSON-RPC error'
    if (body.result?.isError) return (body.result.content?.[0]?.text ?? 'tool error').slice(0, 300)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// Flue fails the whole connection on an allowlisted name the server lacks, so an older or newer
// engine gets the intersection instead.
function allowed(available: string[]): string[] {
  const have = new Set(available)
  return ALLOWLIST.filter((t) => have.has(t))
}

export function ironflowConnection(target: Target, available: string[]): McpConnectionDefinition {
  return { name: IRONFLOW_MCP_SERVER, url: target.url, transport: 'streamable-http', auth: target.token, tools: allowed(available), optional: true }
}

/**
 * Flue caches a session's MCP client by server name and keeps its URL until the runtime stops,
 * so a bridge child replaced after a reload, a crash or a cwd change would leave it calling a dead
 * port. Each request asks `route` for the current child instead; the child is stateless, so a new
 * one needs no re-initialize. The URL here is only a placeholder that `fetch` never uses.
 */
export function bridgedConnection(available: string[], route: () => Promise<Target | string>, fetchFn: typeof fetch = fetch): McpConnectionDefinition {
  return {
    name: IRONFLOW_MCP_SERVER,
    url: 'http://127.0.0.1/mcp',
    transport: 'streamable-http',
    tools: allowed(available),
    optional: true,
    fetch: async (_url, init) => {
      const t = await route()
      if (typeof t === 'string') throw new Error(`ironflow mcp is not running: ${t}`)
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${t.token}`)
      return fetchFn(t.url, { ...init, headers })
    }
  }
}

// Flue names a host tool `mcp__<server>__<tool>` after replacing characters outside [A-Za-z0-9_-]
// with `_` and trimming `_` at both ends (sanitizeToolNamePart in @flue/runtime). Auto-approval
// trusts the `mcp__ironflow__` prefix, so a host server that sanitizes to `ironflow` must not mount.
export function claimsIronflowNamespace(serverName: string): boolean {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').toLowerCase() === IRONFLOW_MCP_SERVER
}

export function degradedNotice(target: Target, probe: Exclude<McpProbe, { ok: true }>, bridgeDetail?: string): string {
  const base = remoteNotice(target, probe)
  return bridgeDetail ? `${base} The local \`ironflow mcp\` bridge did not work either: ${bridgeDetail}.` : base
}

export function engineDownNotice(detail: string): string {
  return `Ironflow tools are connected, but \`ironflow mcp\` could not reach the engine (${detail}). They fail until it answers. Start one with \`nohup ironflow serve --dev > .ironflow-dev.log 2>&1 &\`. If the engine needs a key, set IRONFLOW_API_KEY in the agent config.`
}

function remoteNotice(target: Target, probe: Exclude<McpProbe, { ok: true }>): string {
  const server = target.url.replace(/\/api\/v1\/mcp$/, '')
  if (probe.reason === 'unauthorized') {
    return `Ironflow tools unavailable: the server at ${server} rejected the token (${probe.detail}). Set IRONFLOW_API_KEY in the agent config.`
  }
  if (probe.reason === 'disabled') {
    return `Ironflow tools unavailable: the server at ${server} does not serve /api/v1/mcp. Remote MCP is off by default and cannot run under \`serve --dev\`. Start the server without --dev with IRONFLOW_MCP_REMOTE=true, and set IRONFLOW_API_KEY.`
  }
  return `Ironflow tools unavailable: no server at ${server} (${probe.detail}). Start one with \`ironflow serve\`. If ironflow is not installed: \`brew install sahina/tap/ironflow\`.`
}
