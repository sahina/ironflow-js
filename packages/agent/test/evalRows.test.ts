import { appendFile, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendRow, cellKey, cells, claimRoot, loadRows, redact, type Row } from '../eval/rows.js'

const row = (task: string, run: number): Row => ({
  config: 'A', task, contestant: 'ironflow', run, pass: true, agentSec: 1, totalSec: 2, stopReason: 'end_turn', note: '',
  permissions: 0, toolCalls: 0, turns: null, usage: null, costUsd: null, models: [], retried: false
})

describe('cells', () => {
  it('orders config, run, task, contestant and flips the contestant order on even runs', () => {
    const order = cells(['A'], 2, ['01', '02'], ['ironflow', 'baseline']).map((c) => `${c.task}-${c.contestant}-${c.run}`)
    expect(order).toEqual(['01-ironflow-1', '01-baseline-1', '02-ironflow-1', '02-baseline-1', '01-baseline-2', '01-ironflow-2', '02-baseline-2', '02-ironflow-2'])
  })
  it('runs every cell of configuration A before configuration B', () => {
    expect(cells(['A', 'B'], 1, ['01'], ['ironflow']).map((c) => c.config)).toEqual(['A', 'B'])
  })
  it('keys a cell by config, task, contestant and run', () => {
    expect(cellKey({ config: 'B', task: '01', contestant: 'baseline', run: 3 })).toBe('B|01|baseline|3')
  })
})

describe('rows.jsonl', () => {
  it('returns no rows for a missing file', async () => {
    expect(await loadRows(join(await mkdtemp(join(tmpdir(), 'ifr-')), 'rows.jsonl'))).toEqual([])
  })
  it('reads back appended rows', async () => {
    const p = join(await mkdtemp(join(tmpdir(), 'ifr-')), 'rows.jsonl')
    await appendRow(p, row('01', 1))
    await appendRow(p, row('02', 1))
    expect((await loadRows(p)).map((r) => r.task)).toEqual(['01', '02'])
  })
  it('drops a torn last line so the next append is readable', async () => {
    const p = join(await mkdtemp(join(tmpdir(), 'ifr-')), 'rows.jsonl')
    await appendRow(p, row('01', 1))
    await appendFile(p, '{"config":"A","ta')
    expect((await loadRows(p)).map((r) => r.task)).toEqual(['01'])
    await appendRow(p, row('02', 1))
    expect((await loadRows(p)).map((r) => r.task)).toEqual(['01', '02'])
  })
})

describe('claimRoot', () => {
  it('writes meta.json on a new run and accepts the same meta on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ifr-'))
    await claimRoot(root, { model: 'anthropic/claude-sonnet-5' }, false)
    await expect(claimRoot(root, { model: 'anthropic/claude-sonnet-5' }, true)).resolves.toBeUndefined()
  })
  it('refuses to resume with another model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ifr-'))
    await claimRoot(root, { model: 'anthropic/claude-sonnet-5' }, false)
    await expect(claimRoot(root, { model: 'anthropic/claude-haiku-5-5' }, true)).rejects.toThrow(/recorded/)
  })
  it('refuses to resume a folder without meta.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ifr-'))
    await writeFile(join(root, 'rows.jsonl'), '')
    await expect(claimRoot(root, {}, true)).rejects.toThrow(/no meta.json/)
    expect(await readFile(join(root, 'rows.jsonl'), 'utf8')).toBe('')
  })
})

describe('loadRows rewrite', () => {
  it('leaves a file with no torn line unwritten', async () => {
    const p = join(await mkdtemp(join(tmpdir(), 'ifr-')), 'rows.jsonl')
    await appendRow(p, row('01', 1))
    await chmod(p, 0o444)
    expect((await loadRows(p)).map((r) => r.task)).toEqual(['01'])
  })
})

describe('redact', () => {
  it('replaces every secret value and ignores empty ones', () => {
    expect(redact('key=sk-ant-abc123456 again sk-ant-abc123456', ['sk-ant-abc123456', ''])).toBe('key=[redacted] again [redacted]')
  })
})
