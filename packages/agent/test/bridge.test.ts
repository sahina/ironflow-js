import { chmod, copyFile, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { probeMcp, startBridge, type Bridge } from '../src/mcp.js'

let bin: string
let record: string
const open: Bridge[] = []
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifbr-'))
  bin = dir
  await copyFile(fileURLToPath(new URL('./fixtures/fakeIronflow.mjs', import.meta.url)), join(dir, 'ironflow'))
  await chmod(join(dir, 'ironflow'), 0o755)
  record = join(dir, 'record.json')
})
afterEach(() => { for (const b of open.splice(0)) b.stop() })

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ PATH: `${bin}:${process.env.PATH}`, IRONFLOW_FAKE_RECORD: record, ANTHROPIC_API_KEY: 'sk-secret', IRONFLOW_API_KEY: 'ifkey_1', ...extra })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 20)) }
  return false
}

describe('startBridge', () => {
  it('spawns ironflow mcp over loopback streamable-http and hands back a probe-able target', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ifbrw-'))
    const r = await startBridge(env(), { cwd })
    if (!r.ok) throw new Error(r.detail)
    open.push(r.bridge)
    expect(r.bridge.alive()).toBe(true)
    expect(r.bridge.target.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(await probeMcp(r.bridge.target)).toEqual({ ok: true, tools: ['ironflow_list_runs', 'ironflow_emit_event'] })
    const rec = JSON.parse(await readFile(record, 'utf8'))
    expect(rec.args).toEqual(expect.arrayContaining(['mcp', '--transport', 'streamable-http', '--allow-writes', '--static-only']))
    // Engine discovery walks up from the child's cwd, so it must be the workspace.
    expect(await realpath(rec.cwd)).toBe(await realpath(cwd))
    expect(rec.env.IRONFLOW_MCP_BEARER_TOKEN).toBe(r.bridge.target.token)
    expect(rec.env.IRONFLOW_MCP_EXIT_ON_STDIN_CLOSE).toBe('1')
    expect(rec.env.IRONFLOW_API_KEY).toBe('ifkey_1')
    // The child gets no model-provider key.
    expect(rec.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('kills the child on stop', async () => {
    const r = await startBridge(env())
    if (!r.ok) throw new Error(r.detail)
    const { pid } = JSON.parse(await readFile(record, 'utf8'))
    expect(alive(pid)).toBe(true)
    r.bridge.stop()
    // At once, before the exit event: a stopped child must never be handed out again.
    expect(r.bridge.alive()).toBe(false)
    expect(await gone(pid)).toBe(true)
  })

  it('reads through a torn port file write', async () => {
    const r = await startBridge(env({ IRONFLOW_FAKE_MODE: 'torn' }))
    if (!r.ok) throw new Error(r.detail)
    open.push(r.bridge)
    expect(await probeMcp(r.bridge.target)).toMatchObject({ ok: true })
  })

  it('reports failure when ironflow is not on PATH', async () => {
    const r = await startBridge({ PATH: '/nonexistent' })
    expect(r).toEqual({ ok: false, detail: '`ironflow` is not on PATH' })
  })

  it('reports failure when the child exits before it binds', async () => {
    const r = await startBridge(env({ IRONFLOW_FAKE_MODE: 'exit' }))
    // The child's stderr says why; the agent passes it on.
    expect(r).toEqual({ ok: false, detail: 'ironflow mcp exited with code 2: Error: unknown flag: --static-only' })
  })

  it('gives up and kills a child that never writes its port file', async () => {
    const r = await startBridge(env({ IRONFLOW_FAKE_MODE: 'hang' }), { timeoutMs: 300 })
    expect(r).toMatchObject({ ok: false, detail: expect.stringContaining('port') })
    const { pid } = JSON.parse(await readFile(record, 'utf8'))
    expect(await gone(pid)).toBe(true)
  })

  it('reports a temp dir it cannot create instead of throwing', async () => {
    const saved = process.env.TMPDIR
    process.env.TMPDIR = '/nonexistent/tmp'
    try {
      expect(await startBridge(env())).toMatchObject({ ok: false, detail: expect.stringContaining('temp dir') })
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
  })
})
