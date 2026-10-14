import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureHome } from './paths.js'

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter'

export const PROVIDER_ENV: ReadonlyArray<readonly [ProviderId, string]> = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['google', 'GEMINI_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY']
]

export type Credential = { provider: ProviderId; apiKey: string; source: 'env' | 'file' }
export type CredentialResult =
  | { ok: true; credential: Credential }
  | { ok: false; reason: 'missing' | 'file-mode' }

const FILE = 'credentials.json'

function isProvider(v: unknown): v is ProviderId {
  return PROVIDER_ENV.some(([p]) => p === v)
}

export async function resolveCredential(env: NodeJS.ProcessEnv, home: string): Promise<CredentialResult> {
  for (const [provider, name] of PROVIDER_ENV) {
    const apiKey = env[name]
    if (apiKey) return { ok: true, credential: { provider, apiKey, source: 'env' } }
  }
  const path = join(home, FILE)
  let mode: number
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    return { ok: false, reason: 'missing' }
  }
  // Windows reports 0o666 whatever the ACL says, so the check can only fail there.
  if (process.platform !== 'win32' && mode & 0o077) return { ok: false, reason: 'file-mode' }
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const { provider, apiKey } = (parsed ?? {}) as Record<string, unknown>
    if (isProvider(provider) && typeof apiKey === 'string' && apiKey) {
      return { ok: true, credential: { provider, apiKey, source: 'file' } }
    }
  } catch {
    // Malformed file: same as no file. `login` overwrites it.
  }
  return { ok: false, reason: 'missing' }
}

export async function writeCredential(home: string, c: { provider: ProviderId; apiKey: string }): Promise<void> {
  await ensureHome(home)
  const path = join(home, FILE)
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ provider: c.provider, apiKey: c.apiKey }), { mode: 0o600 })
  await rename(tmp, path)
}

export async function deleteCredential(home: string): Promise<void> {
  await rm(join(home, FILE), { force: true })
}

export function providerEnvFor(c: Credential): Record<string, string> {
  const name = PROVIDER_ENV.find(([p]) => p === c.provider)?.[1]
  if (!name) throw new Error(`unknown provider ${c.provider}`)
  return { [name]: c.apiKey }
}
