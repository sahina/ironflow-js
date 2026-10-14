import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'

const pkg = resolve(import.meta.dirname, '..')

/** Runs dist/cli.js with a clean environment and speaks newline-delimited JSON-RPC to it. */
export function startCli(env: Record<string, string>): {
  stdoutLines: string[]
  stderr(): string
  request(method: string, params: object): Promise<{ result?: any; error?: { code: number; message: string } }>
  stop(): Promise<void>
} {
  const child: ChildProcess = spawn(process.execPath, [join(pkg, 'dist/cli.js')], { env: { PATH: process.env.PATH ?? '', ...env } })
  const stdoutLines: string[] = []
  const waiting = new Map<number, (m: any) => void>()
  let buf = ''
  let err = ''
  child.stdout!.on('data', (b: Buffer) => {
    buf += b.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      stdoutLines.push(line)
      try {
        const m = JSON.parse(line)
        if (typeof m.id === 'number' && !m.method) waiting.get(m.id)?.(m)
      } catch { /* the purity test reports the bad line */ }
    }
  })
  child.stderr!.on('data', (b: Buffer) => { err += b.toString() })
  let nextId = 1
  return {
    stdoutLines,
    stderr: () => err,
    request(method, params) {
      const id = nextId++
      return new Promise((resolveReq, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to ${method}; stderr: ${err}`)), 20_000)
        waiting.set(id, (m) => { clearTimeout(timer); resolveReq(m) })
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    stop() {
      return new Promise((r) => { child.on('exit', () => r()); child.stdin!.end() })
    }
  }
}
