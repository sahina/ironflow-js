import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runScript } from '../eval/check.js'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('runScript', () => {
  it('passes on exit 0 and returns the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-'))
    await writeFile(join(dir, 'ok.sh'), 'echo hello')
    expect(await runScript(join(dir, 'ok.sh'), { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000 })).toMatchObject({ pass: true, output: expect.stringContaining('hello') })
  })
  it('kills what the script started when it times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-'))
    await writeFile(join(dir, 'hang.sh'), `sleep 60 &\necho $! > ${join(dir, 'pid')}\nwait`)
    const res = await runScript(join(dir, 'hang.sh'), { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 500 })
    expect(res.pass).toBe(false)
    expect(res.output).toMatch(/timed out/)
    await new Promise((r) => setTimeout(r, 100))
    expect(alive(Number((await readFile(join(dir, 'pid'), 'utf8')).trim()))).toBe(false)
  })
})
