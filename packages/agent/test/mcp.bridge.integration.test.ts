import { chmod, copyFile, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startBridge } from '../src/mcp.js'
import { serve } from '../src/server.js'
import { sessions } from '../src/sessions.js'

// serve --dev refuses remote MCP, so nothing listens at IRONFLOW_SERVER_URL here: tools can only
// arrive through the `ironflow mcp` child, which test/fixtures/fakeIronflow.mjs stands in for.
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] })
let record: string
let withBinary: boolean
let engineDown = false
let client: ClientSideConnection
let stopServer: () => Promise<void>

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 20)) }
  return false
}
const childPid = async (): Promise<number> => (JSON.parse(await readFile(record, 'utf8')) as { pid: number }).pid

beforeAll(async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const dir = await mkdtemp(join(tmpdir(), 'ifbrs-'))
  await copyFile(fileURLToPath(new URL('./fixtures/fakeIronflow.mjs', import.meta.url)), join(dir, 'ironflow'))
  await chmod(join(dir, 'ironflow'), 0o755)
  record = join(dir, 'record.json')
  const a = new TransformStream<Uint8Array, Uint8Array>()
  const b = new TransformStream<Uint8Array, Uint8Array>()
  const s = await serve({
    input: a.readable, output: b.writable, home: await mkdtemp(join(tmpdir(), 'ifmh-')), providers: [faux.provider], inMemory: true,
    env: {
      ANTHROPIC_API_KEY: 'sk-test', IRONFLOW_AGENT_MODEL: 'faux/m1', IRONFLOW_SERVER_URL: 'http://127.0.0.1:1',
      IRONFLOW_FAKE_RECORD: record
    },
    // The agent snapshots its env, so each test picks its PATH and engine state here.
    bridge: (env, o) => startBridge({ ...env, PATH: withBinary ? `${dir}:${process.env.PATH}` : '/nonexistent', IRONFLOW_FAKE_ENGINE: engineDown ? 'down' : 'up' }, o)
  })
  stopServer = s.stop
  const impl = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  } as unknown as Client
  client = new ClientSideConnection(() => impl, ndJsonStream(a.writable, b.readable))
  await client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
})
afterAll(async () => { await stopServer(); vi.restoreAllMocks() })

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), 'ifmw-'))
const newSession = async (cwd: string): Promise<string> => (await client.newSession({ cwd, mcpServers: [] })).sessionId

// One model turn that calls a tool and returns what the tool said.
async function callTool(sessionId: string): Promise<string> {
  let result = ''
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('mcp__ironflow__ironflow_list_runs', {})]),
    (ctx) => { result = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage(fauxText('done')) }
  ])
  expect((await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })).stopReason).toBe('end_turn')
  return result
}

describe('MCP bridge to a stdio-class ironflow child', () => {
  it('mounts the tools through a child that runs in the workspace', async () => {
    withBinary = true
    const cwd = await workspace()
    const sessionId = await newSession(cwd)
    expect(await callTool(sessionId)).toContain(`ran ironflow_list_runs in ${await realpath(cwd)}`)
    await client.closeSession({ sessionId })
  })

  it('shares one child between the sessions of a workspace, and keeps it after a close', async () => {
    withBinary = true
    const cwd = await workspace()
    const a = await newSession(cwd)
    const pid = await childPid()
    const b = await newSession(cwd)
    expect(await childPid()).toBe(pid)
    await client.closeSession({ sessionId: a })
    expect(alive(pid)).toBe(true)
    expect(await callTool(b)).toContain('ran ironflow_list_runs')
    await client.closeSession({ sessionId: b })
  })

  // Flue keeps its first MCP client for a session id until the runtime stops.
  it('calls the new workspace child after a session is reloaded elsewhere', async () => {
    withBinary = true
    const sessionId = await newSession(await workspace())
    expect(await callTool(sessionId)).toContain('ran ironflow_list_runs')
    await client.closeSession({ sessionId })
    const other = await workspace()
    await client.loadSession({ sessionId, cwd: other, mcpServers: [] })
    expect(await callTool(sessionId)).toContain(`in ${await realpath(other)}`)
    await client.closeSession({ sessionId })
  })

  it('restarts a child that died mid-session', async () => {
    withBinary = true
    const sessionId = await newSession(await workspace())
    const pid = await childPid()
    process.kill(pid, 'SIGKILL')
    expect(await gone(pid)).toBe(true)
    expect(await callTool(sessionId)).toContain('ran ironflow_list_runs')
    expect(await childPid()).not.toBe(pid)
    await client.closeSession({ sessionId })
  })

  it('mounts the tools but says so when the engine does not answer, then recovers', async () => {
    withBinary = true
    engineDown = true
    const sessionId = await newSession(await workspace())
    const s = sessions.get(sessionId)
    expect(s?.mcp).not.toBeNull()
    expect(s?.notice).toMatch(/could not reach the engine \(dial tcp.*connection refused\)/)
    engineDown = false
    expect(await callTool(sessionId)).toContain('ran ironflow_list_runs')
    expect(sessions.get(sessionId)?.mcpRetry).toBe(false)
    await client.closeSession({ sessionId })
  })

  it('says ironflow is not on PATH when neither the child nor a server is available', async () => {
    withBinary = false
    const sessionId = await newSession(await workspace())
    expect(sessions.get(sessionId)?.notice).toMatch(/Ironflow tools unavailable.*bridge did not work either: `ironflow` is not on PATH/)
    await client.closeSession({ sessionId })
  })

  it('kills every child when the agent stops', async () => {
    withBinary = true
    await newSession(await workspace())
    const pid = await childPid()
    expect(alive(pid)).toBe(true)
    await stopServer()
    expect(await gone(pid)).toBe(true)
  })
})
