import { expect, it } from 'vitest'
import { defaultModel, resolveModel } from '../src/models.js'

it('has a default per provider', () => {
  for (const p of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
    expect(defaultModel(p)).toMatch(/^[a-z]+\/.+/)
  }
})
it('IRONFLOW_AGENT_MODEL overrides', () => {
  expect(resolveModel({ IRONFLOW_AGENT_MODEL: 'openai/x' }, 'anthropic')).toBe('openai/x')
  expect(resolveModel({}, 'anthropic')).toBe(defaultModel('anthropic'))
})
it('defaults to the model the ship gate measured', () => {
  expect(defaultModel('anthropic')).toBe('anthropic/claude-sonnet-5-5')
  expect(defaultModel('openrouter')).toBe('openrouter/anthropic/claude-sonnet-5.5')
})
