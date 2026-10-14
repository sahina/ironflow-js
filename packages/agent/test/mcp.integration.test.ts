import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IRONFLOW_ASK_TOOLS, IRONFLOW_READ_TOOLS } from '../src/permissions.js'
import { serve } from '../src/server.js'

// One live Flue runtime per process; vitest forks each test file, so this file owns its runtime.
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] })
const TOKEN = 'ifkey_test_token'

// Models the engine's remote MCP handler (internal/mcp/remote.go): stateless, plain JSON, GET answers 405.
// Serves every allowlisted tool but one, plus a destructive tool the agent must never offer.
const MISSING = 'ironflow_rebuild_projection'
const served = [...IRONFLOW_READ_TOOLS, ...IRONFLOW_ASK_TOOLS].filter((t) => t !== MISSING)
const listing = [...served, 'ironflow_delete_run']

const calls: string[] = []
const authHeaders: Array<string | undefined> = []
let down = false
let stub: Server
let serverUrl: string

const readBody = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization)
    if (down) { res.writeHead(503).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const msg = await readBody(req)
    if (msg.id === undefined) { res.writeHead(202).end(); return }
    const reply = (result: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } })
    else if (msg.method === 'tools/list') reply({ tools: listing.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: { name: { type: 'string' } } } })) })
    else if (msg.method === 'tools/call') { calls.push(msg.params.name); reply({ content: [{ type: 'text', text: `ran ${msg.params.name}` }] }) }
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})

let permission: (req: any) => Promise<any>
const allowOnce = async (): Promise<any> => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
let client: ClientSideConnection
let stopServer: () => Promise<void>

beforeAll(async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const a = new TransformStream<Uint8Array, Uint8Array>()
  const b = new TransformStream<Uint8Array, Uint8Array>()
  const s = await serve({
    input: a.readable, output: b.writable, home: await mkdtemp(join(tmpdir(), 'ifmh-')), providers: [faux.provider], inMemory: true,
    env: { ANTHROPIC_API_KEY: 'sk-test', IRONFLOW_AGENT_MODEL: 'faux/m1', IRONFLOW_SERVER_URL: serverUrl, IRONFLOW_API_KEY: TOKEN }
  })
  stopServer = s.stop
  const impl = { sessionUpdate: async () => {}, requestPermission: (r: unknown) => permission(r) } as unknown as Client
  client = new ClientSideConnection(() => impl, ndJsonStream(a.writable, b.readable))
  await client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
})
afterAll(async () => {
  await stopServer()
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  vi.restoreAllMocks()
})

const prompt = async (sessionId: string): Promise<void> => {
  const r = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
  expect(r.stopReason).toBe('end_turn')
}
const newSession = async (): Promise<string> => (await client.newSession({ cwd: await mkdtemp(join(tmpdir(), 'ifmw-')), mcpServers: [] })).sessionId

describe('MCP tools through Flue against a stateless JSON server', () => {
  it('runs a read tool with no prompt', async () => {
    permission = async () => { throw new Error('a read tool must not prompt') }
    const sessionId = await newSession()
    calls.length = 0
    faux.setResponses([fauxAssistantMessage([fauxToolCall('mcp__ironflow__ironflow_list_runs', {})]), fauxAssistantMessage(fauxText('done'))])
    await prompt(sessionId)
    expect(calls).toEqual(['ironflow_list_runs'])
  })

  it('prompts for a mutating tool, shows the server and the arguments, and runs it once approved', async () => {
    const asked: any[] = []
    permission = async (r) => { asked.push(r.toolCall); return allowOnce() }
    const sessionId = await newSession()
    calls.length = 0
    faux.setResponses([fauxAssistantMessage([fauxToolCall('mcp__ironflow__ironflow_emit_event', { name: 'order.created' })]), fauxAssistantMessage(fauxText('done'))])
    await prompt(sessionId)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ title: 'ironflow: ironflow_emit_event', rawInput: { name: 'order.created' } })
    expect(calls).toEqual(['ironflow_emit_event'])
  })

  it('does not run a rejected call and tells the model it was declined', async () => {
    permission = async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
    const sessionId = await newSession()
    calls.length = 0
    let seen = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('mcp__ironflow__ironflow_emit_event', { name: 'x' })]),
      (ctx) => { seen = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage(fauxText('ok')) }
    ])
    await prompt(sessionId)
    expect(calls).toEqual([])
    expect(seen).toContain('declined')
    expect(seen).toContain('"isError":true')
  })

  it('offers the allowlisted tools the server has, and never a destructive one', async () => {
    permission = allowOnce
    const sessionId = await newSession()
    let offered: string[] = []
    faux.setResponses([(ctx) => {
      offered = ((ctx.messages[0] as any).toolsAdded as Array<{ name: string }>).map((t) => t.name)
      return fauxAssistantMessage(fauxText('ok'))
    }])
    await prompt(sessionId)
    const mcp = offered.filter((n) => n.startsWith('mcp__'))
    expect(mcp).toContain('mcp__ironflow__ironflow_list_runs')
    expect(mcp).toContain('mcp__ironflow__ironflow_emit_event')
    expect(mcp).not.toContain('mcp__ironflow__ironflow_delete_run')
    // The server lacks it, so the allowlist drops it instead of failing the whole connection.
    expect(mcp).not.toContain(`mcp__ironflow__${MISSING}`)
    expect(mcp).toHaveLength(served.length)
  })

  it('sends the token as a bearer header on every request', async () => {
    expect(authHeaders.length).toBeGreaterThan(0)
    expect(new Set(authHeaders)).toEqual(new Set([`Bearer ${TOKEN}`]))
  })

  it('mounts the tools on a later prompt when the server was down at session start', async () => {
    permission = allowOnce
    down = true
    const sessionId = await newSession()
    down = false
    calls.length = 0
    faux.setResponses([fauxAssistantMessage([fauxToolCall('mcp__ironflow__ironflow_list_runs', {})]), fauxAssistantMessage(fauxText('done'))])
    await prompt(sessionId)
    expect(calls).toEqual(['ironflow_list_runs'])
  })
})
