import { describe, expect, it } from 'vitest'
import { anthropicAt } from '../src/runtime.js'

describe('anthropicAt', () => {
  it('points the provider and every model at the override, so no request can reach production', () => {
    const p = anthropicAt('http://127.0.0.1:9')
    const models = p.getModels()
    expect(p.baseUrl).toBe('http://127.0.0.1:9')
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) expect(m.baseUrl).toBe('http://127.0.0.1:9')
  })
})
