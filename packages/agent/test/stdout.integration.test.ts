import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startCli } from './rpcChild.js'

it('writes only JSON-RPC lines to stdout, and answers session/new with auth-required when there is no key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ifo-'))
  const cli = startCli({ HOME: home, IRONFLOW_AGENT_HOME: home, IRONFLOW_SERVER_URL: 'http://127.0.0.1:1' })
  await cli.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const res = await cli.request('session/new', { cwd: home, mcpServers: [] })
  await cli.stop()
  expect(res.error?.code).toBe(-32000)
  expect(cli.stdoutLines.length).toBeGreaterThanOrEqual(2)
  for (const l of cli.stdoutLines) expect(JSON.parse(l).jsonrpc).toBe('2.0')
}, 60_000)
