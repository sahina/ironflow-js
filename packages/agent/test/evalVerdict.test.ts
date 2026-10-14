import { describe, expect, it } from 'vitest'
import { sampleGap, shipGate, type Outcome } from '../eval/verdict.js'

type Opts = { config?: Outcome['config']; stopReason?: string }
const row = (task: string, contestant: Outcome['contestant'], pass: boolean, o: Opts = {}): Outcome =>
  ({ task, contestant, pass, config: o.config ?? 'A', stopReason: o.stopReason ?? 'end_turn' })
const runs = (task: string, contestant: Outcome['contestant'], passed: number, total: number, o: Opts = {}): Outcome[] =>
  Array.from({ length: total }, (_, i) => row(task, contestant, i < passed, o))

describe('ship gate verdict', () => {
  it('is met when ironflow passes at least as often as the baseline', () => {
    expect(shipGate([row('01', 'ironflow', true), row('01', 'baseline', true)]).kind).toBe('met')
    expect(shipGate([row('01', 'ironflow', true), row('01', 'baseline', false)]).kind).toBe('met')
  })

  it('is not met on the total clause when ironflow passes less often', () => {
    const v = shipGate([row('01', 'ironflow', false), row('01', 'baseline', true)])
    expect(v).toMatchObject({ kind: 'not-met', failed: ['total'], vetoTasks: [] })
  })

  it('is not met on the per-task clause even when the totals are equal', () => {
    const v = shipGate([...runs('01', 'ironflow', 0, 5), ...runs('01', 'baseline', 2, 5), ...runs('02', 'ironflow', 5, 5), ...runs('02', 'baseline', 3, 5)])
    expect(v).toMatchObject({ kind: 'not-met', ironflow: 0.5, baseline: 0.5, failed: ['per-task'], vetoTasks: ['01'] })
  })

  it('does not veto a task the baseline passed only once', () => {
    const v = shipGate([...runs('01', 'ironflow', 0, 5), ...runs('01', 'baseline', 1, 5), ...runs('02', 'ironflow', 5, 5), ...runs('02', 'baseline', 4, 5)])
    expect(v.kind).toBe('met')
  })

  it('reports per-task tallies', () => {
    const v = shipGate([...runs('01', 'ironflow', 3, 5), ...runs('01', 'baseline', 4, 5)])
    expect(v.kind === 'invalid' ? null : v.perTask['01']).toEqual({ ironflow: { passed: 3, total: 5 }, baseline: { passed: 4, total: 5 } })
  })

  it('ignores configuration B rows, including incomplete ones', () => {
    const v = shipGate([row('01', 'ironflow', true), row('01', 'baseline', true), row('01', 'ironflow', false, { config: 'B' }), row('01', 'baseline', true, { config: 'B', stopReason: 'error' })])
    expect(v).toMatchObject({ kind: 'met', ironflow: 1, baseline: 1 })
  })

  it('is invalid, never met, when a configuration A run did not complete', () => {
    expect(shipGate([row('01', 'ironflow', true), row('01', 'baseline', false, { stopReason: 'error' })])).toEqual({ kind: 'invalid', incomplete: 1, missing: [] })
    expect(shipGate([row('01', 'ironflow', true), row('01', 'baseline', false, { stopReason: 'harness-error' })]).kind).toBe('invalid')
    expect(shipGate([row('01', 'ironflow', true, { stopReason: '' }), row('01', 'baseline', true)]).kind).toBe('invalid')
  })

  it('is invalid when a contestant has no configuration A runs', () => {
    expect(shipGate([row('01', 'ironflow', true)])).toEqual({ kind: 'invalid', incomplete: 0, missing: ['baseline'] })
    expect(shipGate([row('01', 'ironflow', true, { config: 'B' }), row('01', 'baseline', true, { config: 'B' })])).toEqual({ kind: 'invalid', incomplete: 0, missing: ['ironflow', 'baseline'] })
  })
})

describe('sample gap', () => {
  const full = (task: string): Outcome[] => [...runs(task, 'ironflow', 5, 5), ...runs(task, 'baseline', 3, 5)]
  it('is null for at least 5 configuration A runs per contestant on every task', () => {
    expect(sampleGap([...full('01'), ...full('02')], ['01', '02'])).toBeNull()
  })
  it('names each task with fewer than 5 configuration A runs, including a task with none', () => {
    const rows = [...full('01'), ...runs('02', 'ironflow', 5, 5), ...runs('02', 'baseline', 3, 4), ...runs('03', 'ironflow', 5, 5, { config: 'B' }), ...runs('03', 'baseline', 5, 5, { config: 'B' })]
    expect(sampleGap(rows, ['01', '02', '03'])).toBe('fewer than 5 configuration A runs per contestant for 02, 03')
  })
  it('refuses a baseline that passed no configuration A run', () => {
    expect(sampleGap([...runs('01', 'ironflow', 0, 5), ...runs('01', 'baseline', 0, 5)], ['01'])).toMatch(/baseline passed no configuration A run/)
  })
})
