import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { FileStat, SandboxDriver, ShellResult } from '@flue/runtime'
import { OutsideWorkspaceError, resolveInside } from './contain.js'

export type AcpFsPort = Pick<AgentSideConnection, 'readTextFile' | 'writeTextFile' | 'createTerminal'>

export interface DriverOptions {
  cwd: string
  sessionId: string
  client: AcpFsPort | null
  caps: { readTextFile: boolean; writeTextFile: boolean; terminal: boolean }
  /** The agent's own state directory; the file verbs refuse it even when it sits under `cwd`. */
  home?: string
  log?: (msg: string) => void
  /** Used when the model passes no timeout. A foreground `ironflow serve` would otherwise hang the turn. */
  defaultTimeoutMs?: number
}

export const OUTPUT_LIMIT = 1_000_000
export const DEFAULT_TIMEOUT_MS = 600_000

// process.env holds the provider key (copied in at session/new). The model reads everything a
// command prints, so commands get an allowlisted env, never the agent's own.
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TZ|NODE_OPTIONS|IRONFLOW_SERVER_URL|IRONFLOW_API_KEY|PNPM_HOME|NVM_DIR|GOPATH|GOROOT|JAVA_HOME|PYTHONPATH|VIRTUAL_ENV)$/
export function commandEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_ALLOW.test(k)) env[k] = v
  return { ...env, ...extra }
}
const TRUNCATED = '\n[output truncated]'

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

function capped(): { push(b: Buffer): void; text(): string } {
  const parts: Buffer[] = []
  let size = 0
  let cut = false
  return {
    push(b) {
      if (size >= OUTPUT_LIMIT) { cut = true; return }
      const room = OUTPUT_LIMIT - size
      parts.push(b.length > room ? b.subarray(0, room) : b)
      size += Math.min(b.length, room)
      if (b.length > room) cut = true
    },
    text() { return Buffer.concat(parts).toString('utf8') + (cut ? TRUNCATED : '') }
  }
}

function localExec(command: string, cwd: string, env: Record<string, string> | undefined, timeoutMs: number, signal: AbortSignal | undefined): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const child = spawn('sh', ['-c', command], { cwd, env: commandEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = capped()
    const err = capped()
    let timedOut = false
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    // detached + negative pid kills the whole group, so `npm test` children die too.
    const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }
    const timer = setTimeout(() => { timedOut = true; err.push(Buffer.from(`\n[timed out after ${timeoutMs} ms]`)); kill() }, timeoutMs)
    const onAbort = (): void => { clearTimeout(timer); kill(); reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: out.text(), stderr: err.text(), exitCode: timedOut ? 124 : (code ?? 1) })
    })
  })
}

export function createAcpDriver(opts: DriverOptions): SandboxDriver {
  const { cwd, sessionId, client, caps, home } = opts
  const inside = (p: string): Promise<string> => resolveInside(cwd, p, home)

  return {
    async readFile(p) {
      const abs = await inside(p)
      if (client && caps.readTextFile) return (await client.readTextFile({ sessionId, path: abs })).content
      return readFile(abs, 'utf8')
    },
    async readFileBuffer(p) {
      return new Uint8Array(await readFile(await inside(p)))
    },
    async writeFile(p, content) {
      const abs = await inside(p)
      if (client && caps.writeTextFile && typeof content === 'string') {
        await client.writeTextFile({ sessionId, path: abs, content })
        return
      }
      await writeFile(abs, content)
    },
    async stat(p): Promise<FileStat> {
      const s = await stat(await inside(p))
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime }
    },
    async readdir(p) {
      return readdir(await inside(p))
    },
    async exists(p) {
      try { await stat(await inside(p)); return true } catch (e) {
        if (e instanceof OutsideWorkspaceError) throw e
        return false
      }
    },
    async mkdir(p, o) {
      await mkdir(await inside(p), { recursive: o?.recursive ?? false })
    },
    async rm(p, o) {
      await rm(await inside(p), { recursive: o?.recursive ?? false, force: o?.force ?? false })
    },
    async exec(command, o) {
      const runIn = await inside(o?.cwd ?? '.')
      const timeoutMs = o?.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
      if (!(client && caps.terminal)) return localExec(command, runIn, o?.env, timeoutMs, o?.signal)
      if (o?.signal?.aborted) throw abortError()
      // env is only the caller's extras: the editor spawns the terminal and supplies its own base env.
      const term = await client.createTerminal({
        sessionId, command: 'sh', args: ['-c', command], cwd: runIn,
        env: Object.entries(o?.env ?? {}).map(([name, value]) => ({ name, value })),
        outputByteLimit: OUTPUT_LIMIT
      })
      // A kill racing the terminal's own exit can reject; that must not become an unhandled rejection.
      const kill = (): void => { term.kill().catch(() => {}) }
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      let onAbort: (() => void) | undefined
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => { kill(); reject(abortError()) }
          if (o?.signal?.aborted) onAbort()
          else o?.signal?.addEventListener('abort', onAbort, { once: true })
        })
        // On timeout, kill the terminal; waitForExit then resolves with the kill's exit status.
        timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
        const exit = await Promise.race([term.waitForExit(), aborted])
        const { output, truncated } = await term.currentOutput()
        if (timedOut) return { stdout: output + (truncated ? TRUNCATED : ''), stderr: `[timed out after ${timeoutMs} ms]`, exitCode: 124 }
        return { stdout: output + (truncated ? TRUNCATED : ''), stderr: '', exitCode: exit.exitCode ?? 1 }
      } finally {
        if (timer) clearTimeout(timer)
        if (onAbort) o?.signal?.removeEventListener('abort', onAbort)
        await term.release()
      }
    }
  }
}
