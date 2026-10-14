import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteCredential, providerEnvFor, resolveCredential, writeCredential } from '../src/auth.js'
import { agentHome } from '../src/paths.js'

let home: string
beforeEach(async () => { home = join(await mkdtemp(join(tmpdir(), 'ifa-')), 'home') })

describe('agentHome', () => {
  it('honours IRONFLOW_AGENT_HOME', () => {
    expect(agentHome({ IRONFLOW_AGENT_HOME: '/x/y' })).toBe('/x/y')
  })
  it('defaults under the user home', () => {
    expect(agentHome({ HOME: '/u' })).toBe('/u/.ironflow/agent')
  })
})

describe('resolveCredential', () => {
  it('reports missing with no env and no file', async () => {
    expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
  })
  it('takes the first provider env var in lookup order', async () => {
    const r = await resolveCredential({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, home)
    expect(r).toEqual({ ok: true, credential: { provider: 'openai', apiKey: 'o', source: 'env' } })
  })
  it('ignores empty env values', async () => {
    expect(await resolveCredential({ ANTHROPIC_API_KEY: '' }, home)).toEqual({ ok: false, reason: 'missing' })
  })
  it('reads the file when no env var is set', async () => {
    await writeCredential(home, { provider: 'anthropic', apiKey: 'sk-file' })
    const r = await resolveCredential({}, home)
    expect(r).toEqual({ ok: true, credential: { provider: 'anthropic', apiKey: 'sk-file', source: 'file' } })
  })
  it('lets env win over the file', async () => {
    await writeCredential(home, { provider: 'anthropic', apiKey: 'sk-file' })
    const r = await resolveCredential({ ANTHROPIC_API_KEY: 'sk-env' }, home)
    expect(r.ok && r.credential.source).toBe('env')
  })
  it('refuses a file readable by others', async () => {
    await writeCredential(home, { provider: 'anthropic', apiKey: 'sk-file' })
    await chmod(join(home, 'credentials.json'), 0o644)
    expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'file-mode' })
  })
  it('skips the mode check on Windows, where every file reports 0o666', async () => {
    await writeCredential(home, { provider: 'anthropic', apiKey: 'sk-file' })
    await chmod(join(home, 'credentials.json'), 0o644)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect((await resolveCredential({}, home)).ok).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
  it('treats a malformed file as missing', async () => {
    await writeCredential(home, { provider: 'anthropic', apiKey: 'k' })
    await writeFile(join(home, 'credentials.json'), '{not json', { mode: 0o600 })
    expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('writeCredential / deleteCredential', () => {
  it('writes 0600 inside a 0700 dir', async () => {
    await writeCredential(home, { provider: 'openai', apiKey: 'k' })
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, 'credentials.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8'))).toEqual({ provider: 'openai', apiKey: 'k' })
  })
  it('delete is idempotent', async () => {
    await deleteCredential(home)
    await writeCredential(home, { provider: 'openai', apiKey: 'k' })
    await deleteCredential(home)
    expect(await resolveCredential({}, home)).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('providerEnvFor', () => {
  it('maps the credential to the env var pi-ai reads', () => {
    expect(providerEnvFor({ provider: 'google', apiKey: 'g', source: 'file' })).toEqual({ GEMINI_API_KEY: 'g' })
  })
})
