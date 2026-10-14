import { describe, expect, it } from 'vitest'
import { guard, SKILLS, upstreamFailure } from '../eval/guards.js'
import { zeroUsage, type MeteredRequest } from '../eval/meter.js'

const req = (model: string, tools: string[]): MeteredRequest => ({ path: '/v1/messages', model, tools, status: 200, usage: zeroUsage() })
const fullBody = JSON.stringify({ tools: [{ name: 'mcp__ironflow__list_runs' }], system: `skills:\n${SKILLS.map((s) => `- ironflow:${s}: does things`).join('\n')}` })

describe('guard', () => {
  it('passes a baseline whose main loop uses the model and offers Ironflow MCP and all skills', () => {
    expect(guard('baseline', 'A', 'claude-sonnet-5', [req('claude-haiku-5-5', []), req('claude-sonnet-5', ['Read', 'mcp__ironflow__list_runs'])], fullBody)).toBeNull()
  })
  it('fails a run whose calls never reached the meter', () => {
    expect(guard('ironflow', 'A', 'claude-sonnet-5', [], null)).toMatch(/no model request with tools/)
  })
  it('fails a main loop on another model', () => {
    expect(guard('ironflow', 'A', 'claude-sonnet-5', [req('claude-opus-5-5', ['Read'])], '{}')).toMatch(/claude-opus-5-5, expected claude-sonnet-5/)
  })
  it('allows a later tool-bearing request on another model (a subagent)', () => {
    expect(guard('ironflow', 'A', 'claude-sonnet-5', [req('claude-sonnet-5', ['Read']), req('claude-haiku-5-5', ['Read'])], '{}')).toBeNull()
  })
  it('fails a baseline that offers no Ironflow MCP', () => {
    expect(guard('baseline', 'A', 'claude-sonnet-5', [req('claude-sonnet-5', ['Read'])], `{"system":"${SKILLS.join(' ')}"}`)).toMatch(/mcp__ironflow__/)
  })
  it('fails a baseline whose request does not name every skill', () => {
    const body = JSON.stringify({ tools: [{ name: 'mcp__ironflow__list_runs' }], system: '- ironflow:ironflow-start: a\n- ironflow:ironflow-code: b' })
    expect(guard('baseline', 'A', 'claude-sonnet-5', [req('claude-sonnet-5', ['mcp__ironflow__list_runs'])], body)).toBe('baseline request does not name skills: ironflow-docs, ironflow-ops, ironflow-fit')
  })
  it('requires Ironflow MCP for the agent in configuration B only', () => {
    expect(guard('ironflow', 'A', 'claude-sonnet-5', [req('claude-sonnet-5', ['Read'])], '{}')).toBeNull()
    expect(guard('ironflow', 'B', 'claude-sonnet-5', [req('claude-sonnet-5', ['Read'])], '{}')).toMatch(/configuration B/)
    expect(guard('ironflow', 'B', 'claude-sonnet-5', [req('claude-sonnet-5', ['mcp__ironflow__list_runs'])], fullBody)).toBeNull()
  })
})

describe('upstream failure', () => {
  it('names the error statuses of Messages calls', () => {
    expect(upstreamFailure([req('claude-sonnet-5-5', ['Read']), { ...req('claude-sonnet-5-5', ['Read']), status: 529 }, { ...req('claude-sonnet-5-5', []), status: 502 }]))
      .toBe('the model API returned 529, 502')
  })
  it('is null when every call succeeded', () => {
    expect(upstreamFailure([req('claude-sonnet-5-5', ['Read'])])).toBeNull()
  })
})

describe('guard skill listing', () => {
  it('does not count a skill named only in another skill description', () => {
    const body = JSON.stringify({ tools: [{ name: 'mcp__ironflow__list_runs' }], system: `- ironflow:ironflow-code: NOT for setup (use ironflow-start), docs (ironflow-docs), ops (ironflow-ops), fit (ironflow-fit)` })
    expect(guard('baseline', 'A', 'm', [req('m', ['mcp__ironflow__list_runs'])], body)).toBe('baseline request does not name skills: ironflow-start, ironflow-docs, ironflow-ops, ironflow-fit')
  })
})
