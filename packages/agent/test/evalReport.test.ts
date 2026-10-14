import { describe, expect, it } from 'vitest'
import { report } from '../eval/report.js'
import type { Row } from '../eval/rows.js'

const mk = (p: Partial<Row> & Pick<Row, 'config' | 'task' | 'contestant' | 'run' | 'pass'>): Row => ({
  agentSec: 10, totalSec: 20, stopReason: 'end_turn', note: '', permissions: 1, toolCalls: 4, turns: 6,
  usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite5m: 10, cacheWrite1h: 0 }, costUsd: 0.5, models: ['claude-sonnet-5-5'], retried: false, ...p
})
const set = (config: Row['config'], task: string, contestant: Row['contestant'], passed: number, total: number): Row[] =>
  Array.from({ length: total }, (_, i) => mk({ config, task, contestant, run: i + 1, pass: i < passed }))

describe('report', () => {
  const rows = [
    ...set('A', '01', 'ironflow', 0, 5), ...set('A', '01', 'baseline', 2, 5),
    ...set('A', '02', 'ironflow', 5, 5), ...set('A', '02', 'baseline', 3, 5),
    ...set('B', '01', 'ironflow', 5, 5), ...set('B', '01', 'baseline', 0, 5)
  ]
  const out = report(rows, ['ironflow', 'baseline'], ['01', '02'])

  it('gives per-task rates for each configuration', () => {
    expect(out).toContain('## Configuration A (decides the gate)')
    expect(out).toContain('| 01 | 0/5 | 2/5 |')
    expect(out).toContain('| 02 | 5/5 | 3/5 |')
    expect(out).toContain('| total | 5/10 | 5/10 |')
    expect(out).toContain('## Configuration B (information only)')
  })
  it('gives medians, tokens and the models seen', () => {
    expect(out).toContain('| ironflow | 10 | 0.50 | 6 | 1110 | 50 | 1 | 0 |')
    expect(out).toContain('| A | 01 | ironflow | 1 | FAIL | 10 | 20 | 6 | 1110 | 50 | 0.50 | 1 | end_turn |  |  |')
    expect(out).toContain('Models seen: claude-sonnet-5-5')
  })
  it('names the failed clause and task', () => {
    expect(out).toContain('NOT MET (per-task; tasks 01)')
  })
  it('lists retried cells', () => {
    expect(report([...set('A', '01', 'ironflow', 1, 1), mk({ config: 'A', task: '01', contestant: 'baseline', run: 1, pass: true, retried: true })], ['ironflow', 'baseline'], ['01']))
      .toContain('Retried cells: A/01/baseline#1')
  })
  it('never says MET for a configuration B only run', () => {
    const b = report([...set('B', '01', 'ironflow', 1, 1), ...set('B', '01', 'baseline', 1, 1)], ['ironflow', 'baseline'], ['01'])
    expect(b).toContain('Ship gate NOT evaluated: no configuration A runs for ironflow, baseline.')
    expect(b).not.toMatch(/: MET\./)
  })
  it('says INVALID when a configuration A run did not complete', () => {
    const v = report([...set('A', '01', 'ironflow', 1, 1), mk({ config: 'A', task: '01', contestant: 'baseline', run: 1, pass: false, stopReason: 'harness-error', retried: true })], ['ironflow', 'baseline'], ['01'])
    expect(v).toContain('Ship gate INVALID: 1 configuration A run(s) did not complete after a retry.')
  })
  it('does not evaluate the gate with one contestant', () => {
    expect(report(set('A', '01', 'ironflow', 1, 1), ['ironflow'], ['01'])).toContain('Ship gate (D6) NOT evaluated')
  })
  it('shows n/a for an unpriced cost and an unmetered run', () => {
    expect(report([mk({ config: 'A', task: '01', contestant: 'ironflow', run: 1, pass: true, costUsd: null, usage: null })], ['ironflow'], ['01'])).toContain('| ironflow | 10 | n/a | 6 | n/a | n/a | 1 | 0 |')
  })
  it('does not judge a pilot-sized sample', () => {
    const p = report([...set('A', '04', 'ironflow', 1, 1), ...set('A', '04', 'baseline', 1, 1)], ['ironflow', 'baseline'], ['01', '04'])
    expect(p).toContain('Ship gate NOT evaluated: fewer than 5 configuration A runs per contestant for 01, 04.')
    expect(p).not.toMatch(/: MET\./)
  })
  it('names why a retried cell first failed and what that attempt cost', () => {
    const r = mk({ config: 'A', task: '01', contestant: 'baseline', run: 1, pass: true, retried: true, firstAttempt: { stopReason: 'error', note: 'agent exited early', costUsd: 0.1 } })
    const out = report([...set('A', '01', 'ironflow', 1, 1), r], ['ironflow', 'baseline'], ['01'])
    expect(out).toContain('Retried cells: A/01/baseline#1 (first attempt: error, agent exited early)')
    expect(out).toContain('Spent on failed first attempts: $0.10')
  })
  it('does not judge a sweep on a model other than the gate model', () => {
    const rows = [...set('A', '01', 'ironflow', 5, 5), ...set('A', '01', 'baseline', 5, 5)].map((r) => ({ ...r, models: ['claude-opus-5-5'] }))
    expect(report(rows, ['ironflow', 'baseline'], ['01'])).toContain('Ship gate NOT evaluated: the gate model is claude-sonnet-5-5; configuration A used claude-opus-5-5.')
  })
})

