import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Transcript } from '../src/transcript.js'
import { mkdir, readdir, utimes } from 'node:fs/promises'
import { pruneSessions, sessionDays } from '../src/transcript.js'

it('replays updates in order and survives a new instance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  const t = new Transcript(home, 's1')
  await t.append({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } })
  await t.append({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } })
  const out = []
  for await (const u of new Transcript(home, 's1').replay()) out.push(u)
  expect(out.map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk'])
})

it('replays nothing for an unknown session', async () => {
  const out = []
  for await (const u of new Transcript(await mkdtemp(join(tmpdir(), 'ift-')), 'none').replay()) out.push(u)
  expect(out).toEqual([])
})

it('writes the file 0600 inside a 0700 sessions dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  await new Transcript(home, 's2').append({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } })
  expect((await stat(join(home, 'sessions', 's2.jsonl'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(home, 'sessions'))).mode & 0o777).toBe(0o700)
})

it.each(['../x', 'a/b', 'a\\b', '..', '', 'a\0b'])('rejects session id %j', (id) => {
  expect(() => new Transcript('/h', id)).toThrow(/invalid session id/)
})

const upd = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as const
const replayed = async (t: Transcript) => {
  const out: string[] = []
  for await (const u of t.replay()) out.push((u as { content: { text: string } }).content.text)
  return out
}

it('replays the good lines when the last line is torn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  await new Transcript(home, 's3').append(upd('a'))
  await appendFile(join(home, 'sessions', 's3.jsonl'), '{"sessionUpdate":"agent_mess')
  expect(await replayed(new Transcript(home, 's3'))).toEqual(['a'])
})

it('keeps a torn tail on its own line when appending after it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  await new Transcript(home, 's4').append(upd('a'))
  await appendFile(join(home, 'sessions', 's4.jsonl'), '{"sessionUpdate":"agent_mess')
  const t = new Transcript(home, 's4')
  await t.append(upd('b'))
  await t.append(upd('c'))
  expect(await replayed(new Transcript(home, 's4'))).toEqual(['a', 'b', 'c'])
})

it('replays un-awaited appends in call order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  const t = new Transcript(home, 's5')
  const texts = Array.from({ length: 200 }, (_, i) => String(i))
  await Promise.all(texts.map((x) => t.append(upd(x))))
  expect(await replayed(t)).toEqual(texts)
})

it('rejects a failed append but still writes the next one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  await writeFile(join(home, 'sessions'), 'not a dir') // mkdir of the sessions dir fails
  const t = new Transcript(home, 's6')
  await expect(t.append(upd('x'))).rejects.toThrow()
  await rm(join(home, 'sessions'))
  await t.append(upd('y'))
  expect(await replayed(t)).toEqual(['y'])
})

it('prunes transcripts older than the limit and keeps newer ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  await mkdir(join(home, 'sessions'))
  await writeFile(join(home, 'sessions', 'old.jsonl'), '{}\n')
  await writeFile(join(home, 'sessions', 'new.jsonl'), '{}\n')
  const day = 86_400_000
  const now = Date.now()
  await utimes(join(home, 'sessions', 'old.jsonl'), new Date(now - 31 * day), new Date(now - 31 * day))
  expect(await pruneSessions(home, 30, () => {}, now)).toBe(1)
  expect(await readdir(join(home, 'sessions'))).toEqual(['new.jsonl'])
})
it('keeps everything at 0 days, and has nothing to do with no sessions folder', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ift-'))
  expect(await pruneSessions(home, 30, () => {})).toBe(0)
  await mkdir(join(home, 'sessions'))
  await writeFile(join(home, 'sessions', 'a.jsonl'), '{}\n')
  await utimes(join(home, 'sessions', 'a.jsonl'), new Date(0), new Date(0))
  expect(await pruneSessions(home, 0, () => {})).toBe(0)
  expect(await readdir(join(home, 'sessions'))).toEqual(['a.jsonl'])
})
it('reads the limit from IRONFLOW_AGENT_SESSION_DAYS and falls back to 30 on a bad value', () => {
  const logs: string[] = []
  expect(sessionDays({}, (m) => logs.push(m))).toBe(30)
  expect(sessionDays({ IRONFLOW_AGENT_SESSION_DAYS: '7' }, (m) => logs.push(m))).toBe(7)
  expect(sessionDays({ IRONFLOW_AGENT_SESSION_DAYS: '0' }, (m) => logs.push(m))).toBe(0)
  expect(logs).toEqual([])
  for (const v of ['-1', '1.5', 'ten', '']) expect(sessionDays({ IRONFLOW_AGENT_SESSION_DAYS: v }, (m) => logs.push(m))).toBe(30)
  expect(logs).toHaveLength(4)
})
