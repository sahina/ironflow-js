import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai'
import { expect, it, vi } from 'vitest'
import { serve } from '../src/server.js'

it('a cancel during the pre-prompt MCP probe ends the turn as cancelled and never calls the model', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] })
  let modelCalls = 0
  faux.setResponses([() => { modelCalls++; return fauxAssistantMessage(fauxText('never')) }])
  let calls = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let probing!: () => void
  const probeStarted = new Promise<void>((r) => { probing = r })
  const fetchFn = (async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed') // session/new probe
    probing()
    await held
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  const a = new TransformStream<Uint8Array, Uint8Array>()
  const b = new TransformStream<Uint8Array, Uint8Array>()
  const home = await mkdtemp(join(tmpdir(), 'ifc-'))
  const s = await serve({ input: a.readable, output: b.writable, home, env: { ANTHROPIC_API_KEY: 'sk-test', IRONFLOW_AGENT_MODEL: 'faux/m1' }, providers: [faux.provider], inMemory: true, fetchFn })
  const updates: any[] = []
  const client = new ClientSideConnection(() => ({ sessionUpdate: async (n: any) => { updates.push(n.update) }, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }) as unknown as Client, ndJsonStream(a.writable, b.readable))
  try {
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: await mkdtemp(join(tmpdir(), 'ifw-')), mcpServers: [] })
    const turn = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await probeStarted
    await client.cancel({ sessionId })
    release()
    expect((await turn).stopReason).toBe('cancelled')
    expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(false)
    expect(modelCalls).toBe(0)
  } finally {
    await s.stop()
    vi.restoreAllMocks()
  }
})
