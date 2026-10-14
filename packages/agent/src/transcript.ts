import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionUpdate } from './translate.js'

// Holds only the updates we sent to the editor; no keys, no prompts beyond what the user typed.
export class Transcript {
  private readonly dir: string
  private readonly path: string

  constructor(home: string, sessionId: string) {
    // An id is a filename: no separator, no `..`, so it cannot leave the sessions dir.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
    this.dir = join(home, 'sessions')
    this.path = join(this.dir, `${sessionId}.jsonl`)
  }

  // Appends run one at a time so replay order is call order. A failed write rejects its own
  // caller but must not stall the chain for the next one.
  private tail: Promise<void> = Promise.resolve()
  private tornTailChecked = false

  append(u: SessionUpdate): Promise<void> {
    const run = this.tail.then(() => this.write(u))
    this.tail = run.catch(() => {})
    return run
  }

  private async write(u: SessionUpdate): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // A crash can leave a half-written last line; start a new line so it cannot glue to this update.
    const prefix = this.tornTailChecked || (await this.endsMidLine()) === false ? '' : '\n'
    await appendFile(this.path, `${prefix}${JSON.stringify(u)}\n`, { mode: 0o600 })
    this.tornTailChecked = true
  }

  private async endsMidLine(): Promise<boolean> {
    let fh
    try {
      fh = await open(this.path, 'r')
    } catch {
      return false
    }
    try {
      const { size } = await fh.stat()
      if (size === 0) return false
      const last = Buffer.alloc(1)
      await fh.read(last, 0, 1, size - 1)
      return last[0] !== 0x0a
    } finally {
      await fh.close()
    }
  }

  async *replay(): AsyncIterable<SessionUpdate> {
    let stream
    try {
      stream = createReadStream(this.path, 'utf8')
      await new Promise((resolve, reject) => { stream!.once('open', resolve); stream!.once('error', reject) })
    } catch {
      return
    }
    // Split on \n only; readline's crlfDelay keeps \r\n inside JSON strings intact.
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line) continue
      let u: SessionUpdate
      try {
        u = JSON.parse(line) as SessionUpdate
      } catch {
        continue // torn line from a crash; skip it without echoing its text
      }
      yield u
    }
  }
}

const DEFAULT_SESSION_DAYS = 30

export function sessionDays(env: NodeJS.ProcessEnv, log: (m: string) => void): number {
  const raw = env.IRONFLOW_AGENT_SESSION_DAYS
  if (raw === undefined) return DEFAULT_SESSION_DAYS
  if (/^[0-9]+$/.test(raw)) return Number(raw)
  log(`IRONFLOW_AGENT_SESSION_DAYS=${JSON.stringify(raw)} is not a whole number of days; using ${DEFAULT_SESSION_DAYS}`)
  return DEFAULT_SESSION_DAYS
}

// Transcripts hold prompts and tool output in plain text; without a limit they pile up forever.
export async function pruneSessions(home: string, days: number, log: (m: string) => void, now = Date.now()): Promise<number> {
  if (days === 0) return 0
  const dir = join(home, 'sessions')
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return [] as string[]; throw e })
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      if (now - (await stat(path)).mtimeMs > days * 86_400_000) {
        await rm(path)
        removed++
      }
    } catch (e) {
      log(`could not prune ${name}: ${(e as Error).message}`)
    }
  }
  return removed
}
