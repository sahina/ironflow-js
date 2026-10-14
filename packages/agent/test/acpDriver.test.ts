import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTPUT_LIMIT, createAcpDriver, type AcpFsPort } from '../src/sandbox/acpDriver.js'
import { OutsideWorkspaceError } from '../src/sandbox/contain.js'

let ws: string
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'ifd-')) })

function fakeClient() {
  const kill = vi.fn(async () => ({}))
  const release = vi.fn(async () => undefined)
  const client = {
    readTextFile: vi.fn(async (p: { path: string }) => ({ content: `buffer:${p.path}` })),
    writeTextFile: vi.fn(async () => ({})),
    createTerminal: vi.fn(async (): Promise<Record<string, unknown>> => ({
      id: 't1',
      waitForExit: async () => ({ exitCode: 0, signal: null }),
      currentOutput: async () => ({ output: 'hello\n', truncated: false }),
      kill, release
    }))
  }
  return { client: client as unknown as AcpFsPort, raw: client, kill, release }
}

const allCaps = { readTextFile: true, writeTextFile: true, terminal: true }
const noCaps = { readTextFile: false, writeTextFile: false, terminal: false }

describe('ACP route', () => {
  it('reads and writes through the client with absolute paths and the session id', async () => {
    const f = fakeClient()
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
    expect(await d.readFile('a.txt')).toMatch(/^buffer:.*a\.txt$/)
    await d.writeFile('b.txt', 'B')
    expect(f.raw.writeTextFile).toHaveBeenCalledWith({ sessionId: 's1', path: expect.stringMatching(/b\.txt$/), content: 'B' })
  })
  it('runs exec in a client terminal with the output limit, then releases it', async () => {
    const f = fakeClient()
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
    const r = await d.exec('echo hello')
    expect(f.raw.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', command: 'sh', args: ['-c', 'echo hello'], outputByteLimit: OUTPUT_LIMIT
    }))
    expect(r).toMatchObject({ stdout: 'hello\n', exitCode: 0 })
    expect(f.release).toHaveBeenCalled()
  })
  it('notes truncation when the client terminal truncated its output', async () => {
    const f = fakeClient()
    f.raw.createTerminal.mockResolvedValueOnce({
      id: 't3',
      waitForExit: async () => ({ exitCode: 0, signal: null }),
      currentOutput: async () => ({ output: 'xxx', truncated: true }),
      kill: f.kill, release: f.release
    })
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
    expect((await d.exec('big')).stdout).toBe('xxx\n[output truncated]')
  })
  it('kills the client terminal on abort', async () => {
    const f = fakeClient()
    f.raw.createTerminal.mockResolvedValueOnce({
      id: 't2',
      waitForExit: () => new Promise(() => {}),
      currentOutput: async () => ({ output: '', truncated: false }),
      kill: f.kill, release: f.release
    })
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
    const ac = new AbortController()
    const p = d.exec('sleep 100', { signal: ac.signal })
    await vi.waitFor(() => expect(f.raw.createTerminal).toHaveBeenCalled())
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(f.kill).toHaveBeenCalled()
    expect(f.release).toHaveBeenCalled()
  })
  it('kills the client terminal when the default timeout passes with no timeoutMs', async () => {
    const f = fakeClient()
    type Exit = { exitCode: number | null; signal: string | null }
    let exit!: (v: Exit) => void
    f.kill.mockImplementation(async () => { exit({ exitCode: null, signal: 'SIGKILL' }); return {} })
    f.raw.createTerminal.mockResolvedValueOnce({
      id: 't4',
      waitForExit: () => new Promise<Exit>((r) => { exit = r }),
      currentOutput: async () => ({ output: '', truncated: false }),
      kill: f.kill, release: f.release
    })
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps, defaultTimeoutMs: 100 })
    const r = await d.exec('sleep 100', { timeoutMs: undefined })
    expect(f.kill).toHaveBeenCalled()
    // Same marker as the local route, so the model can tell a timeout from a failure.
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('[timed out after 100 ms]')
    expect(f.release).toHaveBeenCalled()
  })
  it('writes binary content locally even when the client can write text', async () => {
    const f = fakeClient()
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
    await d.writeFile('bin', new Uint8Array([1, 2]))
    expect(f.raw.writeTextFile).not.toHaveBeenCalled()
    expect([...(await readFile(join(ws, 'bin')))]).toEqual([1, 2])
  })
  it('does not forward the host env into the client terminal', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak-check'
    try {
      const f = fakeClient()
      const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: f.client, caps: allCaps })
      await d.exec('env', { env: { FOO: 'bar' } })
      const [arg] = f.raw.createTerminal.mock.calls[0] as unknown as [{ env: { name: string; value: string }[] }]
      expect(arg.env).toEqual([{ name: 'FOO', value: 'bar' }])
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe('local route', () => {
  it('uses the filesystem when the client has no fs capability', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
    await d.writeFile('c.txt', 'C')
    expect(await readFile(join(ws, 'c.txt'), 'utf8')).toBe('C')
    expect(await d.readFile('c.txt')).toBe('C')
    expect(await d.exists('c.txt')).toBe(true)
    expect(await d.readdir('.')).toContain('c.txt')
  })
  it('runs exec in the session cwd and caps output', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
    const r = await d.exec('pwd')
    expect(r.stdout.trim().endsWith(ws.split('/').pop()!)).toBe(true)
    const big = await d.exec(`head -c ${OUTPUT_LIMIT + 5000} /dev/zero | tr '\\0' a`)
    expect(big.stdout.length).toBeLessThanOrEqual(OUTPUT_LIMIT + 100)
    expect(big.stdout).toContain('[output truncated]')
  })
  it('caps stderr at the same limit', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
    const big = await d.exec(`head -c ${OUTPUT_LIMIT + 5000} /dev/zero | tr '\\0' a 1>&2`)
    expect(big.stderr.length).toBeLessThanOrEqual(OUTPUT_LIMIT + 100)
    expect(big.stderr).toContain('[output truncated]')
  })
  it('never passes the provider key or other host secrets to the command', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak-check'
    process.env.SOME_TOKEN = 'tok-leak-check'
    try {
      const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
      const r = await d.exec('env')
      expect(r.stdout).not.toContain('sk-leak-check')
      expect(r.stdout).not.toContain('tok-leak-check')
      expect(r.stdout).toMatch(/^PATH=/m)
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.SOME_TOKEN
    }
  })
  it('applies a default timeout when exec gets no timeoutMs', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps, defaultTimeoutMs: 200 })
    const r = await d.exec('sleep 5', { timeoutMs: undefined })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('[timed out after 200 ms]')
  })
  it('gives a command no stdin, so one that reads it ends instead of waiting for the timeout', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
    const r = await d.exec('cat; echo done', { timeoutMs: 5_000 })
    expect(r).toMatchObject({ stdout: 'done\n', exitCode: 0 })
  })
  it('lets an explicit timeoutMs override the default', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps, defaultTimeoutMs: 60_000 })
    const r = await d.exec('sleep 5', { timeoutMs: 150 })
    expect(r.stderr).toContain('[timed out after 150 ms]')
  })
  it('stops a local process on abort', async () => {
    const d = createAcpDriver({ cwd: ws, sessionId: 's1', client: null, caps: noCaps })
    const ac = new AbortController()
    const p = d.exec('sleep 100', { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toThrow(/abort/i)
  })
})

it('every path verb enforces containment on both routes', async () => {
  await writeFile(join(ws, 'ok'), 'x')
  for (const d of [
    createAcpDriver({ cwd: ws, sessionId: 's', client: fakeClient().client, caps: allCaps }),
    createAcpDriver({ cwd: ws, sessionId: 's', client: null, caps: noCaps })
  ]) {
    await expect(d.readFile('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.readFileBuffer('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.writeFile('../x', 'y')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.stat('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.readdir('..')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.exists('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.mkdir('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.rm('../x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.exec('true', { cwd: '/' })).rejects.toBeInstanceOf(OutsideWorkspaceError)
  }
})

it('writeFile and mkdir through a dangling symlink to the outside create nothing there', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ifo-'))
  await symlink(join(out, 'newfile'), join(ws, 'dangling'))
  const d = createAcpDriver({ cwd: ws, sessionId: 's', client: null, caps: noCaps })
  await expect(d.writeFile('dangling', 'PWNED')).rejects.toBeInstanceOf(OutsideWorkspaceError)
  await expect(d.mkdir('dangling')).rejects.toBeInstanceOf(OutsideWorkspaceError)
  await expect(access(join(out, 'newfile'))).rejects.toThrow()
})

describe('agent home inside the workspace', () => {
  // The editor opened a parent directory, so the agent's own files sit under the workspace root.
  it.each([['ACP route', true], ['local route', false]])('refuses every file verb on the home, %s', async (_name, acp) => {
    const home = join(ws, '.ironflow', 'agent')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'credentials.json'), '{"apiKey":"sk-secret"}')
    const f = fakeClient()
    const d = createAcpDriver(acp
      ? { cwd: ws, sessionId: 's', client: f.client, caps: allCaps, home }
      : { cwd: ws, sessionId: 's', client: null, caps: noCaps, home })
    const target = '.ironflow/agent/credentials.json'
    await expect(d.readFile(target)).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.readFileBuffer(target)).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.writeFile(target, 'x')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.exists(target)).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.readdir('.ironflow/agent')).rejects.toBeInstanceOf(OutsideWorkspaceError)
    await expect(d.exec('ls', { cwd: '.ironflow/agent' })).rejects.toBeInstanceOf(OutsideWorkspaceError)
    expect(f.raw.readTextFile).not.toHaveBeenCalled()
    expect(await readFile(join(home, 'credentials.json'), 'utf8')).toBe('{"apiKey":"sk-secret"}')
  })
})
