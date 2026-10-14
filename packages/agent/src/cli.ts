#!/usr/bin/env node
import { Readable, Writable } from 'node:stream'
import { startBridge } from './mcp.js'
import { agentHome } from './paths.js'
import { runLogin, runLogout, terminalIO } from './login.js'
import { serve } from './server.js'
import { pruneSessions, sessionDays } from './transcript.js'

// stdout is the ACP channel. Anything that writes to it by accident corrupts the stream.
console.log = (...a: unknown[]) => { process.stderr.write(`${a.map(String).join(' ')}\n`) }
console.info = console.log
console.debug = console.log

const USAGE = 'usage: ironflow-agent [login|logout [--purge]]\n  (no argument)    run as an ACP agent on stdio\n  login            store a model provider API key\n  logout           remove the stored key\n  logout --purge   also remove the session transcripts and flue.db\n'
const cmd = process.argv[2]

if (cmd === 'login') {
  await runLogin(terminalIO(), agentHome()).catch((e: Error) => { process.stderr.write(`login failed: ${e.message}\n`); process.exit(1) })
} else if (cmd === 'logout') {
  const flag = process.argv[3]
  if (flag !== undefined && flag !== '--purge') { process.stderr.write(USAGE); process.exit(2) }
  await runLogout(terminalIO(), agentHome(), { purge: flag === '--purge' })
} else if (cmd === '--help' || cmd === '-h') {
  process.stdout.write(USAGE)
} else if (cmd === undefined) {
  const log = (m: string): void => { process.stderr.write(`[ironflow-agent] ${m}\n`) }
  await pruneSessions(agentHome(), sessionDays(process.env, log), log).catch((e: Error) => log(`session prune failed: ${e.message}`))
  const s = await serve({
    input: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    home: agentHome(),
    env: process.env,
    bridge: startBridge
  })
  const stop = async (): Promise<void> => {
    // A hung shutdown must not leave an orphan process behind an editor that has gone.
    setTimeout(() => process.exit(0), 5000).unref()
    await s.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  process.stdin.on('end', () => void stop())
} else {
  process.stderr.write(USAGE)
  process.exit(2)
}
