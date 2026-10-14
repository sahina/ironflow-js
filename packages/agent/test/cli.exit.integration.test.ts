import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startCli } from './rpcChild.js'

it('exits within about 5 s after stdin ends, with a model call still open', async () => {
  let reached!: () => void
  const modelCalled = new Promise<void>((r) => { reached = r })
  // An upstream that accepts the call and never answers: the turn stays in flight.
  const hung = createServer(() => { reached() })
  await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r))
  const home = await mkdtemp(join(tmpdir(), 'ife-'))
  const cli = startCli({
    HOME: home, IRONFLOW_AGENT_HOME: home, IRONFLOW_SERVER_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'sk-test', IRONFLOW_AGENT_ANTHROPIC_BASE_URL: `http://127.0.0.1:${(hung.address() as AddressInfo).port}`
  })
  try {
    await cli.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    // The workspace must not be the agent home: the agent refuses to read inside its own home.
    const { result } = await cli.request('session/new', { cwd: await mkdtemp(join(tmpdir(), 'ifw-')), mcpServers: [] })
    void cli.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
    await modelCalled
    const t0 = Date.now()
    await cli.stop()
    expect(Date.now() - t0).toBeLessThan(6_500)
  } finally {
    hung.closeAllConnections()
    hung.close()
  }
}, 60_000)
