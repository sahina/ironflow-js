import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drive, stopAgents } from '../eval/acpDriverClient.js'

describe('stopAgents', () => {
  it('ends a running agent so an interrupted sweep stops spending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifdc-'))
    const t0 = Date.now()
    const pending = drive({ command: 'sleep', args: ['60'], env: { PATH: process.env.PATH ?? '' } }, { cwd: dir, prompt: 'x', transcriptPath: join(dir, 't.jsonl'), stderrPath: join(dir, 'e.log') })
    await new Promise((r) => setTimeout(r, 300))
    stopAgents()
    expect((await pending).stopReason).toBe('error')
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})
