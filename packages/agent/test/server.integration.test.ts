import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deleteCredential, writeCredential } from '../src/auth.js'
import { serve } from '../src/server.js'
import { sessions } from '../src/sessions.js'

// One live Flue runtime per process; vitest forks each test file, so this file owns its runtime.
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] })
const updates: any[] = []
const allowOnce = async (): Promise<any> => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
let permission: (req: any) => Promise<any> = allowOnce
let client: ClientSideConnection
let stopServer: () => Promise<void>
let home: string
const logged: string[] = []
const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
const env = { ANTHROPIC_API_KEY: 'sk-test', IRONFLOW_AGENT_MODEL: 'faux/m1' }

function pipePair() {
  const a = new TransformStream<Uint8Array, Uint8Array>()
  const b = new TransformStream<Uint8Array, Uint8Array>()
  return { agentIn: a.readable, clientOut: a.writable, clientIn: b.readable, agentOut: b.writable }
}

const idleClient = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) } as unknown as Client
const text = (t: string) => [{ type: 'text' as const, text: t }]
const workspace = () => mkdtemp(join(tmpdir(), 'ifw-'))

beforeAll(async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true })
  home = await mkdtemp(join(tmpdir(), 'ifi-'))
  const p = pipePair()
  const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
  stopServer = s.stop
  const impl: Client = {
    sessionUpdate: async (n) => { updates.push(n.update) },
    requestPermission: (r) => permission(r),
    readTextFile: async () => { throw new Error('no fs in this client') },
    writeTextFile: async () => { throw new Error('no fs in this client') }
  } as Client
  client = new ClientSideConnection(() => impl, ndJsonStream(p.clientOut, p.clientIn))
  const init = await client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } } })
  expect(init.agentCapabilities?.loadSession).toBe(true)
  expect(init.agentCapabilities?.sessionCapabilities?.close).toBeTruthy()
  expect(init.authMethods).toEqual([expect.objectContaining({ id: 'login', type: 'terminal', args: ['login'] })])
})
afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
})

describe('one full turn', () => {
  it('streams a tool call, asks permission, edits the file and ends the turn', async () => {
    const cwd = await workspace()
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'a.ts', content: 'export const a = 1' })]),
      fauxAssistantMessage(fauxText('Wrote a.ts.'))
    ])
    updates.length = 0
    const res = await client.prompt({ sessionId, prompt: text('write a.ts') })
    expect(res.stopReason).toBe('end_turn')
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('export const a = 1')
    const kinds = updates.map((u) => u.sessionUpdate)
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('tool_call_update')
    expect(kinds).toContain('agent_message_chunk')
    // ACP requires absolute paths; the model sent a relative one.
    expect(updates.find((u) => u.sessionUpdate === 'tool_call').locations[0].path).toBe(join(cwd, 'a.ts'))
  })
})

describe('cancel during a permission prompt', () => {
  it('ends cancelled and leaves the file untouched', async () => {
    const cwd = await workspace()
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    faux.setResponses([fauxAssistantMessage([fauxToolCall('write', { path: 'b.ts', content: 'x' })]), fauxAssistantMessage(fauxText('never'))])
    let opened!: () => void
    const promptOpen = new Promise<void>((r) => { opened = r })
    permission = () => { opened(); return new Promise(() => {}) }
    try {
      const turn = client.prompt({ sessionId, prompt: text('write b') })
      await promptOpen
      await client.cancel({ sessionId })
      expect((await turn).stopReason).toBe('cancelled')
      await expect(readFile(join(cwd, 'b.ts'))).rejects.toThrow()
      // The open request_permission must resolve, not dangle after the turn ends.
      expect((sessions.get(sessionId)!.gate as any).pending.size).toBe(0)
    } finally {
      permission = allowOnce
    }
  })
})

describe('concurrency', () => {
  it('rejects a second prompt while a turn is live, and the first turn completes', async () => {
    const cwd = await workspace()
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    let release!: () => void
    let started!: () => void
    const modelCalled = new Promise<void>((r) => { started = r })
    faux.setResponses([async () => { started(); await new Promise<void>((r) => { release = r }); return fauxAssistantMessage(fauxText('first')) }])
    const first = client.prompt({ sessionId, prompt: text('one') })
    await modelCalled
    await expect(client.prompt({ sessionId, prompt: text('two') })).rejects.toMatchObject({ code: -32600 })
    release()
    expect((await first).stopReason).toBe('end_turn')
  })

  it('rejects a second prompt sent back to back, before the first reaches the model', async () => {
    const { sessionId } = await client.newSession({ cwd: await workspace(), mcpServers: [] })
    faux.setResponses([fauxAssistantMessage(fauxText('only'))])
    const results = await Promise.allSettled([
      client.prompt({ sessionId, prompt: text('one') }),
      client.prompt({ sessionId, prompt: text('two') })
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('session/load', () => {
  it('replays the transcript of an earlier session', async () => {
    const cwd = await workspace()
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    faux.setResponses([fauxAssistantMessage(fauxText('remember me'))])
    await client.prompt({ sessionId, prompt: text('hello') })
    updates.length = 0
    await client.loadSession({ sessionId, cwd, mcpServers: [] })
    const replayed = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')
    expect(updates[0]).toMatchObject({ sessionUpdate: 'user_message_chunk', content: { text: 'hello' } })
    expect(replayed).toBe('remember me')
  })
})

describe('MCP comes online after session/new', () => {
  const body = (init?: RequestInit): any => JSON.parse(String(init?.body ?? '{}'))
  const reply = (id: unknown, result: object): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })

  it('mounts the Ironflow tools on the first prompt after the server starts', async () => {
    let online = false
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      if (!online) throw new TypeError('fetch failed')
      const b = body(init)
      return reply(b.id, b.method === 'tools/list' ? { tools: [{ name: 'ironflow_list_runs' }] } : {})
    }) as unknown as typeof fetch
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await c.newSession({ cwd: await workspace(), mcpServers: [] })
    expect(sessions.get(sessionId)?.mcp).toBeNull()
    expect(sessions.get(sessionId)?.notice).toMatch(/Ironflow tools unavailable/)
    online = true
    faux.setResponses([fauxAssistantMessage(fauxText('ok'))])
    await c.prompt({ sessionId, prompt: text('hi') })
    expect(sessions.get(sessionId)?.mcp?.tools).toEqual(['ironflow_list_runs'])
    expect(sessions.get(sessionId)?.notice).toBeNull()
    await s.stop()
  })

  it('stops re-probing before each turn after a probe hangs to its timeout', async () => {
    let calls = 0
    const hanging = (async () => { calls++; await new Promise((r) => setTimeout(r, 1_100)); throw new TypeError('timeout') }) as unknown as typeof fetch
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: hanging })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await c.newSession({ cwd: await workspace(), mcpServers: [] })
    faux.setResponses([fauxAssistantMessage(fauxText('one')), fauxAssistantMessage(fauxText('two'))])
    await c.prompt({ sessionId, prompt: text('a') })
    await c.prompt({ sessionId, prompt: text('b') })
    // session/new probes and hangs, so both turns are inside the backoff.
    expect(calls).toBe(1)
    await s.stop()
  })

  it('does not repeat the unavailable notice on every turn', async () => {
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await c.newSession({ cwd: await workspace(), mcpServers: [] })
    faux.setResponses([fauxAssistantMessage(fauxText('one')), fauxAssistantMessage(fauxText('two'))])
    await c.prompt({ sessionId, prompt: text('a') })
    await c.prompt({ sessionId, prompt: text('b') })
    expect(sessions.get(sessionId)?.notice).toBeNull()
    await s.stop()
  })
})

describe('editor-supplied MCP servers', () => {
  const http = (name: string) => ({ type: 'http' as const, name, url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'authorization', value: 'Bearer x' }] })

  it('keeps unrelated servers and drops any whose tool prefix would read as the Ironflow one', async () => {
    const { sessionId } = await client.newSession({
      cwd: await workspace(),
      mcpServers: [http('ironflow'), http('ironflow.'), http('_ironflow_'), http('Ironflow'), http('docs'), { name: 'local', command: 'x', args: [], env: [] }]
    })
    // Auto-approval trusts `mcp__ironflow__`, which Flue builds from the sanitized server name.
    expect(sessions.get(sessionId)?.extraMcp.map((m) => m.name)).toEqual(['docs'])
    expect(logged.join('')).toContain('skipping MCP server ironflow:')
  })
})

describe('logs', () => {
  it('carry neither the API key nor prompt text', () => {
    const all = logged.join('')
    expect(all).not.toContain('sk-test')
    expect(all).not.toContain('write a.ts')
    expect(all).not.toContain('remember me')
  })
})

describe('session state', () => {
  it('forgets a session on session/close and answers a later prompt as unknown', async () => {
    const { sessionId } = await client.newSession({ cwd: await workspace(), mcpServers: [] })
    expect(sessions.has(sessionId)).toBe(true)
    await client.closeSession({ sessionId })
    expect(sessions.has(sessionId)).toBe(false)
    await expect(client.prompt({ sessionId, prompt: text('hi') })).rejects.toMatchObject({ code: -32602 })
  })

  it('drops everything for every session when the server stops', async () => {
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const a = await c.newSession({ cwd: await workspace(), mcpServers: [] })
    const b = await c.newSession({ cwd: await workspace(), mcpServers: [] })
    expect(sessions.has(a.sessionId) && sessions.has(b.sessionId)).toBe(true)
    await s.stop()
    expect(sessions.has(a.sessionId) || sessions.has(b.sessionId)).toBe(false)
  })

  it('refuses a session id another connection holds, and closing it there leaves the owner intact', async () => {
    const { sessionId } = await client.newSession({ cwd: await workspace(), mcpServers: [] })
    const owner = sessions.get(sessionId)
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await expect(c.loadSession({ sessionId, cwd: await workspace(), mcpServers: [] })).rejects.toMatchObject({ code: -32600 })
    await c.closeSession({ sessionId })
    await s.stop()
    expect(sessions.get(sessionId)).toBe(owner)
    await client.closeSession({ sessionId })
  })

  it('keeps per-session maps bounded across a reload, a close and a stop', async () => {
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
    const held = (): number[] => ['transcripts', 'tails', 'keys'].map((m) => ((s.agent as any)[m] as Map<string, unknown>).size)
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const cwd = await workspace()
    const { sessionId } = await c.newSession({ cwd, mcpServers: [] })
    faux.setResponses([fauxAssistantMessage(fauxText('hi'))])
    await c.prompt({ sessionId, prompt: text('hi') })
    expect(held()).toEqual([1, 1, 1])
    const first = sessions.get(sessionId)
    await c.loadSession({ sessionId, cwd, mcpServers: [] })
    expect(sessions.get(sessionId)).not.toBe(first)
    expect(held()).toEqual([1, 0, 1])
    await c.closeSession({ sessionId })
    expect(held()).toEqual([0, 0, 0])
    await c.newSession({ cwd, mcpServers: [] })
    expect(held()).toEqual([1, 0, 1])
    await s.stop()
    expect(held()).toEqual([0, 0, 0])
  })
})

describe('auth', () => {
  it('returns auth-required from session/new with no key', async () => {
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home: await mkdtemp(join(tmpdir(), 'ifk-')), env: {}, providers: [faux.provider], inMemory: true, fetchFn: offline })
    const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
    await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await expect(c.newSession({ cwd: tmpdir(), mcpServers: [] })).rejects.toMatchObject({ code: -32000, message: expect.stringMatching(/No model API key/) })
    await s.stop()
  })

  it('advertises the terminal login method only to a client that enabled terminal auth', async () => {
    const initWith = async (clientCapabilities: object) => {
      const p = pipePair()
      const s = await serve({ input: p.agentIn, output: p.agentOut, home, env, providers: [faux.provider], inMemory: true, fetchFn: offline })
      const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
      const res = await c.initialize({ protocolVersion: 1, clientCapabilities })
      await s.stop()
      return res.authMethods
    }
    expect(await initWith({})).toEqual([])
    expect(await initWith({ auth: { terminal: false } })).toEqual([])
    expect(await initWith({ auth: { terminal: true } })).toEqual([expect.objectContaining({ id: 'login', type: 'terminal' })])
    expect(await initWith({ _meta: { 'terminal-auth': false } })).toEqual([])
    expect(await initWith({ _meta: { 'terminal-auth': true } })).toEqual([expect.objectContaining({ id: 'login', type: 'terminal' })])
  })

  it('follows a key rewritten by login or logout while running with env: process.env, as the CLI does', async () => {
    const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]))
    for (const n of names) delete process.env[n]
    const keysHome = await mkdtemp(join(tmpdir(), 'ifk-'))
    const p = pipePair()
    const s = await serve({ input: p.agentIn, output: p.agentOut, home: keysHome, env: process.env, providers: [faux.provider], inMemory: true, fetchFn: offline })
    try {
      const c = new ClientSideConnection(() => idleClient, ndJsonStream(p.clientOut, p.clientIn))
      await c.initialize({ protocolVersion: 1, clientCapabilities: {} })
      await writeCredential(keysHome, { provider: 'anthropic', apiKey: 'sk-old' })
      const first = await c.newSession({ cwd: tmpdir(), mcpServers: [] })
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-old')
      // `login` ran in another process and replaced the file.
      await writeCredential(keysHome, { provider: 'anthropic', apiKey: 'sk-new' })
      const second = await c.newSession({ cwd: tmpdir(), mcpServers: [] })
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-new')
      expect((s.agent as any).keys.get(first.sessionId)).toBe('sk-old')
      expect((s.agent as any).keys.get(second.sessionId)).toBe('sk-new')
      // `logout` removed it: a running agent must stop using the old key.
      await deleteCredential(keysHome)
      await expect(c.newSession({ cwd: tmpdir(), mcpServers: [] })).rejects.toMatchObject({ code: -32000 })
    } finally {
      await s.stop()
      for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
    }
  })
})
