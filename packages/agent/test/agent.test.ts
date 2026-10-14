import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { init, type FlueExecutionContext } from '@flue/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IronflowAgent } from '../src/agent.js'
import { PermissionGate, SUBAGENTS_DENIED_MESSAGE, type PermissionPort } from '../src/permissions.js'
import { gateInterceptor, noteToolArgs, pendingArgsSize, startRuntime } from '../src/runtime.js'
import { sessions, type SessionContext } from '../src/sessions.js'

// One live Flue runtime per process; vitest isolates test files, so no other file shares this one.
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] })
let stop: () => Promise<void>
beforeAll(async () => {
  const flue = await startRuntime({ home: await mkdtemp(join(tmpdir(), 'ifh-')), skills: [{ name: 'demo', description: 'Demo skill for tests.', instructions: '# Demo' }], providers: [faux.provider], inMemory: true })
  stop = () => flue.stop()
})
afterAll(async () => { await stop() })

const allow: PermissionPort = { requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }) }
const caps = { readTextFile: false, writeTextFile: false, terminal: false }

async function session(id: string, port: PermissionPort, where: { cwd?: string; home?: string } = {}): Promise<SessionContext> {
  const cwd = where.cwd ?? await mkdtemp(join(tmpdir(), 'ifw-'))
  const home = where.home ?? await mkdtemp(join(tmpdir(), 'ifhome-'))
  const s: SessionContext = { id, cwd, home, client: null, caps, gate: new PermissionGate(port, id), model: 'faux/m1', mcp: null, mcpRetry: false, extraMcp: [], notice: null }
  sessions.set(id, s)
  return s
}

describe('agent turns', () => {
  it('writes a file through the sandbox after the gate approves, prompting once', async () => {
    const asked: string[] = []
    const s = await session('a1', { requestPermission: async (r) => { asked.push(r.toolCall.title ?? ''); return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'hello.ts', content: 'export {}' })]),
      fauxAssistantMessage(fauxText('done'))
    ])
    const h = init(IronflowAgent, { id: 'a1' })
    const reply = await h.read(await h.dispatch('make hello.ts'))
    expect(reply.text).toBe('done')
    expect(await readFile(join(s.cwd, 'hello.ts'), 'utf8')).toBe('export {}')
    expect(asked).toEqual(['write hello.ts'])
  })

  it('reports a denied write to the model without touching disk', async () => {
    const s = await session('a2', { requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }) })
    let toolResult = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'x.ts', content: '1' })]),
      (ctx) => { toolResult = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage(fauxText('ok')) }
    ])
    const h = init(IronflowAgent, { id: 'a2' })
    await h.read(await h.dispatch('write x'))
    expect(toolResult).toMatch(/declined write/)
    await expect(readFile(join(s.cwd, 'x.ts'))).rejects.toThrow()
  })

  it('refuses the framework task tool, which wrapTools never sees, and the turn completes', async () => {
    await session('a3', allow)
    let toolResult = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { agent: 'general', prompt: 'go', description: 'go' })]),
      (ctx) => { toolResult = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage(fauxText('ok')) }
    ])
    const h = init(IronflowAgent, { id: 'a3' })
    const reply = await h.read(await h.dispatch('delegate'))
    expect(reply.text).toBe('ok')
    expect(toolResult).toContain(SUBAGENTS_DENIED_MESSAGE)
    expect(toolResult).toContain('"isError":true')
  })
})

describe('gateInterceptor', () => {
  const ctx = (instanceId?: string) => ({ instanceId }) as FlueExecutionContext
  const tool = (toolName: string) => ({ type: 'tool', toolCallId: 'c1', toolName }) as const
  const next = async () => 'ran'

  it('denies a non-auto MCP tool when the session is unknown', async () => {
    await expect(gateInterceptor(tool('mcp__other__do'), ctx('nope'), next)).rejects.toThrow(/declined/)
    await expect(gateInterceptor(tool('mcp__other__do'), ctx(undefined), next)).rejects.toThrow(/declined/)
  })

  it('still lets an auto MCP tool through without a session', async () => {
    expect(await gateInterceptor(tool('mcp__ironflow__ironflow_list_runs'), ctx('nope'), next)).toBe('ran')
  })

  it('treats a rejected gate as a decline', async () => {
    await session('g1', { requestPermission: async () => { throw new Error('editor went away') } })
    await expect(gateInterceptor(tool('mcp__other__do'), ctx('g1'), next)).rejects.toThrow(/declined mcp__other__do/)
  })

  it('prompts for an ask-class MCP tool and runs it once approved', async () => {
    let prompts = 0
    await session('g2', { requestPermission: async () => { prompts++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    expect(await gateInterceptor(tool('mcp__ironflow__ironflow_emit_event'), ctx('g2'), next)).toBe('ran')
    expect(prompts).toBe(1)
  })

  it('names the server of a host MCP tool in the prompt', async () => {
    const titles: string[] = []
    await session('g5', { requestPermission: async (r) => { titles.push(r.toolCall.title ?? ''); return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    await gateInterceptor(tool('mcp__evil__ironflow_emit_event'), ctx('g5'), next)
    expect(titles).toEqual(['evil: ironflow_emit_event'])
  })

  it('leaves sandbox tools to wrapTools', async () => {
    let prompts = 0
    await session('g3', { requestPermission: async () => { prompts++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    expect(await gateInterceptor(tool('write'), ctx('g3'), next)).toBe('ran')
    expect(prompts).toBe(0)
  })

  it('denies a tool it does not know, even for a live session', async () => {
    await session('g4', allow)
    await expect(gateInterceptor(tool('something_new'), ctx('g4'), next)).rejects.toThrow(/declined something_new/)
  })

  it('denies the task tool whatever the session', async () => {
    await expect(gateInterceptor(tool('task'), ctx('nope'), next)).rejects.toThrow(SUBAGENTS_DENIED_MESSAGE)
  })
})

describe('noteToolArgs', () => {
  const ctx = (instanceId: string) => ({ instanceId }) as FlueExecutionContext
  const next = async () => 'ran'

  it('keeps nothing for auto, sandbox and deny tools', () => {
    noteToolArgs('n1', 'mcp__ironflow__ironflow_list_runs', {})
    noteToolArgs('n2', 'write', { path: 'a', content: 'b' })
    noteToolArgs('n3', 'task', {})
    expect(pendingArgsSize()).toBe(0)
  })

  it('hands an ask-class MCP call its args and deletes them in the interceptor', async () => {
    let shown: unknown
    await session('n4', { requestPermission: async (r) => { shown = r.toolCall.rawInput; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    noteToolArgs('c9', 'mcp__ironflow__ironflow_emit_event', { name: 'x' })
    expect(pendingArgsSize()).toBe(1)
    await gateInterceptor({ type: 'tool', toolCallId: 'c9', toolName: 'mcp__ironflow__ironflow_emit_event' }, ctx('n4'), next)
    expect(shown).toEqual({ name: 'x' })
    expect(pendingArgsSize()).toBe(0)
  })

  it('caps the map, dropping the oldest entry', async () => {
    for (let i = 0; i < 300; i++) noteToolArgs(`k${i}`, 'mcp__other__do', i)
    expect(pendingArgsSize()).toBe(256)
    // k0 was evicted: its prompt carries no args. k299 is still there.
    const shown: unknown[] = []
    await session('n5', { requestPermission: async (r) => { shown.push(r.toolCall.rawInput); return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } })
    for (const id of ['k0', 'k299']) await gateInterceptor({ type: 'tool', toolCallId: id, toolName: 'mcp__other__do' }, ctx('n5'), next)
    expect(shown).toEqual([undefined, 299])
    for (let i = 1; i < 299; i++) await gateInterceptor({ type: 'tool', toolCallId: `k${i}`, toolName: 'mcp__other__do' }, ctx('n5'), next)
    expect(pendingArgsSize()).toBe(0)
  })
})

// Drives one real Flue tool call and returns what the model sees back.
async function callTool(id: string, name: string, args: Record<string, any>): Promise<{ text: string; isError: boolean }> {
  let last: any
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)]),
    (ctx) => { last = ctx.messages.at(-1); return fauxAssistantMessage(fauxText('ok')) }
  ])
  const h = init(IronflowAgent, { id })
  await h.read(await h.dispatch('go'))
  return { text: JSON.stringify(last.content), isError: last.isError === true }
}

describe('grep and glob stay inside the workspace', () => {
  let prompts = 0
  let ws: string
  let outside: string
  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'ifg-'))
    ws = join(base, 'ws'); outside = join(base, 'out')
    await mkdir(ws); await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'TOPSECRET')
    await writeFile(join(ws, 'keep.txt'), 'inside-needle')
    await mkdir(join(ws, '-d'))
    await writeFile(join(ws, '-d', 'f.txt'), 'x')
    await symlink(outside, join(ws, 'link'))
  })
  const sid = (n: string): string => `gg-${n}`
  const counting: PermissionPort = { requestPermission: async () => { prompts++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } }

  it.each([
    ['grep', '/etc', { pattern: '.' }],
    ['grep', '..', { pattern: '.' }],
    ['grep', 'link', { pattern: '.' }],
    ['glob', '/etc', { pattern: '*' }],
    ['glob', '..', { pattern: '*' }],
    ['glob', 'link', { pattern: '*' }]
  ])('%s refuses path %s with an error and no prompt', async (tool, path, rest) => {
    prompts = 0
    const id = sid(`${tool}${path}`.replace(/\W/g, ''))
    await session(id, counting, { cwd: ws })
    const r = await callTool(id, tool, { ...rest, path })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('path outside workspace')
    expect(r.text).not.toContain('TOPSECRET')
    expect(prompts).toBe(0)
  })

  it('reads a leading-dash path as a directory, not as an option', async () => {
    await session(sid('dash'), counting, { cwd: ws })
    const r = await callTool(sid('dash'), 'glob', { pattern: '*.txt', path: '-d' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('-d/f.txt')
    // `-delete` as a path must not turn into find's action.
    await callTool(sid('dash'), 'glob', { pattern: '*', path: '-delete' })
    await expect(access(join(ws, 'keep.txt'))).resolves.toBeUndefined()
  })

  it('still searches inside the workspace, relative and absolute', async () => {
    await session(sid('ok'), counting, { cwd: ws })
    for (const args of [{ pattern: 'needle' }, { pattern: 'needle', path: '.' }, { pattern: 'needle', path: ws }]) {
      const r = await callTool(sid('ok'), 'grep', args)
      expect(r.isError).toBe(false)
      expect(r.text).toContain('inside-needle')
    }
  })
})

describe('the agent home when the workspace is an ancestor', () => {
  let ws: string
  let home: string
  let prompts = 0
  const counting: PermissionPort = { requestPermission: async () => { prompts++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } } }
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ifa-'))
    home = join(ws, '.ironflow', 'agent')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'credentials.json'), '{"apiKey":"sk-HOMESECRET"}')
  })

  it.each([
    ['read', { path: '.ironflow/agent/credentials.json' }],
    ['grep', { pattern: '.', path: '.ironflow/agent' }],
    ['glob', { pattern: '*', path: '.ironflow/agent' }],
    // A recursive search from the ancestor would walk into the home.
    ['grep', { pattern: 'HOMESECRET' }],
    ['glob', { pattern: 'credentials.json', path: '.' }]
  ])('%s %j is refused with no prompt', async (tool, args) => {
    prompts = 0
    const id = `home-${tool}-${Object.keys(args).join('')}-${JSON.stringify(args).length}`
    await session(id, counting, { cwd: ws, home })
    const r = await callTool(id, tool, args)
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('HOMESECRET')
    expect(prompts).toBe(0)
  })
})
