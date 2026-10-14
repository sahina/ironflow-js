import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveCredential } from '../src/auth.js'
import { runLogin, runLogout, type LoginIO } from '../src/login.js'

function io(answers: string[]): LoginIO & { said: string[]; secretAsked: boolean[] } {
  const said: string[] = []
  const secretAsked: boolean[] = []
  return {
    said, secretAsked,
    ask: async (_q, opts) => { secretAsked.push(Boolean(opts?.secret)); return answers.shift() ?? '' },
    say: (s) => { said.push(s) }
  }
}

it('stores the chosen provider and key, asking for the key as a secret', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  const t = io(['2', 'sk-openai'])
  await runLogin(t, home)
  expect(t.secretAsked).toEqual([false, true])
  const r = await resolveCredential({}, home)
  expect(r).toEqual({ ok: true, credential: { provider: 'openai', apiKey: 'sk-openai', source: 'file' } })
  expect(t.said.join('\n')).not.toContain('sk-openai')
})

it('rejects an invalid choice and an empty key without writing', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  await expect(runLogin(io(['9']), home)).rejects.toThrow(/choose 1-4/)
  await expect(runLogin(io(['1', '  ']), home)).rejects.toThrow(/empty key/)
  expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
})

it('logout removes the file', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  await runLogin(io(['1', 'sk-a']), home)
  await runLogout(io([]), home)
  expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
})

it('logout --purge removes the key, the transcripts and flue.db, and keeps other files', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  await runLogin(io(['1', 'sk-a']), home)
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(join(home, 'sessions', 's.jsonl'), '{}\n')
  for (const f of ['flue.db', 'flue.db-wal', 'flue.db-shm', 'keep.txt']) await writeFile(join(home, f), '')
  const said: string[] = []
  await runLogout({ ask: async () => '', say: (l) => said.push(l) }, home, { purge: true })
  expect(await readdir(home)).toEqual(['keep.txt'])
  expect(said.join('\n')).toMatch(/stored key.*session transcripts.*flue\.db/s)
})
it('logout --purge with nothing stored says so and does not fail', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  const said: string[] = []
  await runLogout({ ask: async () => '', say: (l) => said.push(l) }, home, { purge: true })
  expect(said).toEqual(['Nothing to remove.'])
})
it('plain logout keeps the transcripts', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  await runLogin(io(['1', 'sk-a']), home)
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(join(home, 'sessions', 's.jsonl'), '{}\n')
  await runLogout(io([]), home)
  expect(await readdir(join(home, 'sessions'))).toEqual(['s.jsonl'])
})

it('login refuses on native Windows and stores nothing', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'h')
  await expect(runLogin(io(['1', 'sk-a']), home, 'win32')).rejects.toThrow(/macOS or Linux.*WSL/)
  expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
})
