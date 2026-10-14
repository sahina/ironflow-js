import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { writeCredential } from '../src/auth.js'
import { startCli } from './rpcChild.js'

// Anthropic Messages SSE for one text reply (event shapes recorded in the design's Appendix A).
const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from mock' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const seen: Array<{ url: string; apiKey: string | undefined }> = []
const mock = createServer((req: IncomingMessage, res) => {
  req.resume()
  req.on('end', () => {
    seen.push({ url: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(SSE)
  })
})
let mockUrl = ''
beforeAll(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
})
afterAll(() => { mock.close() })

it('sends the stored key to the overridden Anthropic endpoint, never to production', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ifb-'))
  await writeCredential(home, { provider: 'anthropic', apiKey: 'sk-byok-check' })
  const cli = startCli({ HOME: home, IRONFLOW_AGENT_HOME: home, IRONFLOW_SERVER_URL: 'http://127.0.0.1:1', IRONFLOW_AGENT_ANTHROPIC_BASE_URL: mockUrl })
  try {
    await cli.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await cli.request('session/new', { cwd: await mkdtemp(join(tmpdir(), 'ifbw-')), mcpServers: [] })
    const sessionId = created.result?.sessionId as string
    expect(sessionId, cli.stderr()).toBeTruthy()
    const turn = await cli.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    // A regression that leaves the real base URL in place gets a production 401 here, not end_turn.
    expect(turn.result?.stopReason, cli.stderr()).toBe('end_turn')
  } finally {
    await cli.stop()
  }
  // A full model turn is where a stray stdout write from a dependency would show up.
  for (const l of cli.stdoutLines) expect(JSON.parse(l).jsonrpc).toBe('2.0')
  expect(seen.length).toBeGreaterThan(0)
  for (const r of seen) {
    expect(r.url).toContain('/v1/messages')
    expect(r.apiKey).toBe('sk-byok-check')
  }
  expect(cli.stderr()).not.toContain('sk-byok-check')
}, 60_000)
