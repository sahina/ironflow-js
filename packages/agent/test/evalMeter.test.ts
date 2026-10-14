import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startFakeAnthropic } from '../eval/fakeAnthropic.js'
import { costUsd, startMeter, summarize, usageFromJson, usageFromSse, zeroUsage, type MeteredRequest } from '../eval/meter.js'

const sse = (events: object[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

describe('usage parsing', () => {
  it('takes input and cache counts from message_start and the final output count from message_delta', () => {
    const text = sse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }
    ])
    expect(usageFromSse(text)).toEqual({ input: 10, output: 42, cacheRead: 100, cacheWrite5m: 20, cacheWrite1h: 30 })
  })
  it('counts cache writes as 5-minute writes when the TTL split is absent', () => {
    expect(usageFromJson(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 7 } })))
      .toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite5m: 7, cacheWrite1h: 0 })
  })
  it('returns zero usage for a body that is not JSON', () => {
    expect(usageFromJson('upstream exploded')).toEqual(zeroUsage())
  })
})

describe('cost', () => {
  it('prices input, output, cache reads and both cache-write TTLs', () => {
    // claude-sonnet-5: $2 in, $10 out per MTok; read 0.1x, 5m write 1.25x, 1h write 2x of input.
    expect(costUsd('claude-sonnet-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 4)
  })
  it('gives no cost for a model without a price', () => {
    expect(costUsd('claude-unknown', { ...zeroUsage(), input: 1 })).toBeNull()
  })
  it('summarizes per model, counts only tool-bearing requests as turns, and shows n/a for an unpriced model', () => {
    const req = (model: string, tools: string[], input: number): MeteredRequest => ({ path: '/v1/messages', model, tools, status: 200, usage: { ...zeroUsage(), input } })
    const s = summarize([req('claude-sonnet-5', ['Read'], 10), req('claude-sonnet-5', ['Read'], 20), req('claude-mystery', [], 5)])
    expect(s.turns).toBe(2)
    expect(s.usage.input).toBe(35)
    expect(s.models['claude-sonnet-5']).toMatchObject({ requests: 2, usage: { input: 30 } })
    expect(s.models['claude-mystery']?.costUsd).toBeNull()
    expect(s.costUsd).toBeNull()
  })
})

describe('startMeter', () => {
  it('forwards a streamed call unchanged and records its model, tools and usage', async () => {
    const fake = await startFakeAnthropic()
    const meter = await startMeter(fake.url)
    try {
      const body = JSON.stringify({ model: 'claude-sonnet-5', stream: true, tools: [{ name: 'mcp__ironflow__list_runs' }], messages: [] })
      const res = await fetch(`${meter.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'accept-encoding': 'gzip' }, body })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('event: message_stop')
      expect(fake.seen[0]).toMatchObject({ path: '/v1/messages', body })
      expect(fake.seen[0]?.headers['accept-encoding']).toBe('identity')
      expect(fake.seen[0]?.headers['x-api-key']).toBe('k')
      expect(meter.requests).toEqual([{ path: '/v1/messages', model: 'claude-sonnet-5', tools: ['mcp__ironflow__list_runs'], status: 200, usage: { input: 5, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }])
      expect(meter.firstToolBody()).toBe(body)
    } finally {
      await meter.stop()
      await fake.stop()
    }
  })

  it('records a call that is not streamed, and keeps the first tool-bearing body only', async () => {
    const fake = await startFakeAnthropic()
    const meter = await startMeter(fake.url)
    try {
      const post = (b: object) => fetch(`${meter.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.text())
      await post({ model: 'claude-haiku-5-5', messages: [] })
      await post({ model: 'claude-sonnet-5', tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'first' }] })
      await post({ model: 'claude-sonnet-5', tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'second' }] })
      expect(meter.requests.map((r) => [r.model, r.usage.output])).toEqual([['claude-haiku-5-5', 3], ['claude-sonnet-5', 3], ['claude-sonnet-5', 3]])
      expect(meter.firstToolBody()).toContain('first')
    } finally {
      await meter.stop()
      await fake.stop()
    }
  })

  it('forwards calls that are not Messages calls without recording them', async () => {
    const fake = await startFakeAnthropic()
    const meter = await startMeter(fake.url)
    try {
      // Claude Code checks connectivity with GET /api/hello through ANTHROPIC_BASE_URL.
      expect((await fetch(`${meter.url}/api/hello`)).status).toBe(200)
      await fetch(`${meter.url}/v1/messages/count_tokens`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }) }).then((r) => r.text())
      await fetch(`${meter.url}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }) }).then((r) => r.text())
      expect(fake.seen.map((s) => s.path)).toEqual(['/api/hello', '/v1/messages/count_tokens', '/v1/messages?beta=true'])
      expect(meter.requests.map((r) => r.path)).toEqual(['/v1/messages?beta=true'])
    } finally {
      await meter.stop()
      await fake.stop()
    }
  })

  it('answers 502 and records it when the upstream is down', async () => {
    const meter = await startMeter('http://127.0.0.1:1')
    try {
      const res = await fetch(`${meter.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5', tools: [{ name: 'Read' }] }) })
      expect(res.status).toBe(502)
      expect(meter.requests[0]).toMatchObject({ status: 502, usage: zeroUsage() })
    } finally {
      await meter.stop()
    }
  })
})

describe('review follow-ups', () => {
  it('gives no cost for a run whose calls never reached the meter', () => {
    expect(summarize([]).costUsd).toBeNull()
  })
  it('keeps the 5m/1h cache-write split when message_delta repeats only the flat count', () => {
    const text = sse([
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } } } },
      { type: 'message_delta', usage: { output_tokens: 9, cache_creation_input_tokens: 50 } }
    ])
    expect(usageFromSse(text)).toMatchObject({ cacheWrite5m: 20, cacheWrite1h: 30 })
  })
  it('records a Messages call sent with a trailing slash', async () => {
    const fake = await startFakeAnthropic()
    const meter = await startMeter(fake.url)
    try {
      await fetch(`${meter.url}/v1/messages/`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5' }) }).then((r) => r.text())
      expect(meter.requests.map((r) => r.model)).toEqual(['claude-sonnet-5-5'])
    } finally {
      await meter.stop()
      await fake.stop()
    }
  })
  it('breaks the client stream and records 502 when the upstream dies mid-stream', async () => {
    const up = createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {}\n\n'); setTimeout(() => res.socket?.destroy(), 50) })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const meter = await startMeter(`http://127.0.0.1:${(up.address() as AddressInfo).port}`)
    try {
      const res = await fetch(`${meter.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5' }) })
      await expect(res.text()).rejects.toThrow()
      expect(meter.requests[0]?.status).toBe(502)
    } finally {
      await meter.stop()
      up.closeAllConnections()
      await new Promise<void>((r) => up.close(() => r()))
    }
  })
  it('aborts the upstream call when the client goes away', async () => {
    let upstreamClosed = false
    const up = createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {}\n\n') })
      res.on('close', () => { upstreamClosed = true })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const meter = await startMeter(`http://127.0.0.1:${(up.address() as AddressInfo).port}`)
    try {
      const ac = new AbortController()
      const res = await fetch(`${meter.url}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal })
      expect(res.status).toBe(200)
      ac.abort()
      await new Promise((r) => setTimeout(r, 300))
      expect(upstreamClosed).toBe(true)
    } finally {
      await meter.stop()
      up.closeAllConnections()
      await new Promise<void>((r) => up.close(() => r()))
    }
  })
})
