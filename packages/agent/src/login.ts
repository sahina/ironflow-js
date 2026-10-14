import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { deleteCredential, writeCredential, type ProviderId } from './auth.js'

export interface LoginIO {
  ask(question: string, opts?: { secret?: boolean }): Promise<string>
  say(line: string): void
}

const CHOICES: ReadonlyArray<readonly [ProviderId, string]> = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google Gemini'],
  ['openrouter', 'OpenRouter']
]

export async function runLogin(io: LoginIO, home: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  // v1 runs bash and kills POSIX process groups; nothing has run on native Windows.
  if (platform === 'win32') throw new Error('A stored key needs macOS or Linux. On Windows, use WSL, or set the provider key as an environment variable.')
  io.say('Choose a model provider:')
  CHOICES.forEach(([, label], i) => io.say(`  ${i + 1}) ${label}`))
  const choice = CHOICES[Number.parseInt((await io.ask('Provider [1-4]: ')).trim(), 10) - 1]
  if (!choice) throw new Error('choose 1-4')
  const apiKey = (await io.ask(`${choice[1]} API key: `, { secret: true })).trim()
  if (!apiKey) throw new Error('empty key')
  await writeCredential(home, { provider: choice[0], apiKey })
  io.say(`Saved. The key for ${choice[1]} is stored in ${home}/credentials.json (mode 0600).`)
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

export async function runLogout(io: LoginIO, home: string, opts: { purge?: boolean } = {}): Promise<void> {
  if (!opts.purge) {
    await deleteCredential(home)
    io.say('Removed the stored key.')
    return
  }
  const removed: string[] = []
  if (await exists(join(home, 'credentials.json'))) {
    await deleteCredential(home)
    removed.push('the stored key')
  }
  if (await exists(join(home, 'sessions'))) {
    await rm(join(home, 'sessions'), { recursive: true, force: true })
    removed.push('the session transcripts')
  }
  // SQLite keeps the write-ahead log and shared memory beside the database.
  const db = ['flue.db', 'flue.db-wal', 'flue.db-shm']
  if ((await Promise.all(db.map((f) => exists(join(home, f))))).some(Boolean)) {
    for (const f of db) await rm(join(home, f), { force: true })
    removed.push('flue.db')
  }
  io.say(removed.length > 0 ? `Removed ${removed.join(', ')}.` : 'Nothing to remove.')
}

/** Terminal IO for the real `login` command. Muted output hides the key while it is typed. */
export function terminalIO(): LoginIO {
  let muted = false
  const output = new Writable({
    write(chunk, _enc, cb) { if (!muted) process.stderr.write(chunk); cb() }
  })
  return {
    async ask(question, opts) {
      const rl = createInterface({ input: process.stdin, output, terminal: true })
      process.stderr.write(question)
      muted = Boolean(opts?.secret)
      try { return await rl.question('') } finally { muted = false; rl.close(); if (opts?.secret) process.stderr.write('\n') }
    },
    say(line) { process.stderr.write(`${line}\n`) }
  }
}
