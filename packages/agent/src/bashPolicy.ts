import { constants } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveInside } from './sandbox/contain.js'

export type Segment = string[]
/** A word after quote removal; `glob` when it has an unquoted `*` or `?`, `quoted` when part of it was quoted. */
interface Word { text: string; glob: boolean; quoted: boolean }

// Unquoted characters bash gives a meaning this parser does not model: expansion, redirection,
// grouping, globbing, comments, history, control characters. Any of them means "ask".
const UNQUOTED_REFUSED = new Set(['$', '`', '>', '<', '(', ')', '{', '}', '\\', '~', '#', '!', '[', ']', '\n', '\r', '\v', '\f'])

// Redirects that write nothing: whole words only. `2> /dev/null` or `2>out` still refuse.
const STDERR_DROPS = ['2>/dev/null', '2>&1']

/**
 * Splits a command into pipelines (`;`, `&&`) of simple commands (`|`), or returns null when the
 * command uses anything outside that grammar. Null always means the caller asks the user. A glob
 * is outside the grammar here: what it runs on changes with the files, so it gets no session grant.
 */
export function parseCommand(command: string): Segment[][] | null {
  const parsed = parseWords(command)
  if (!parsed || parsed.some((p) => p.some((c) => c.some((w) => w.glob)))) return null
  return parsed.map((p) => p.map((c) => c.map((w) => w.text)))
}

function parseWords(command: string): Word[][][] | null {
  const pipelines: Word[][][] = []
  let pipeline: Word[][] = []
  let words: Word[] = []
  let word = ''
  let glob = false
  let quoted = false
  let inWord = false
  const endWord = (): void => { if (inWord) { words.push({ text: word, glob, quoted }); word = ''; glob = false; quoted = false; inWord = false } }
  const endCommand = (): boolean => {
    endWord()
    if (words.length === 0) return false
    pipeline.push(words)
    words = []
    return true
  }
  const endPipeline = (): boolean => {
    if (!endCommand()) return false
    pipelines.push(pipeline)
    pipeline = []
    return true
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const drop = inWord ? undefined : STDERR_DROPS.find((d) => command.startsWith(d, i) && /^[ \t|;&]?$/.test(command[i + d.length] ?? ''))
    if (drop) {
      i += drop.length - 1
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1)
      if (j < 0) return null
      word += command.slice(i + 1, j)
      inWord = quoted = true
      i = j
    } else if (c === '"') {
      const j = command.indexOf('"', i + 1)
      if (j < 0) return null
      const inner = command.slice(i + 1, j)
      // In double quotes sh keeps a backslash unless it escapes $ ` " \ or a newline.
      if (/[$`]/.test(inner) || /\\([$`"\\\n]|$)/.test(inner)) return null
      word += inner
      inWord = quoted = true
      i = j
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '|') {
      if (command[i + 1] === '|' || command[i + 1] === '&') return null
      if (!endCommand()) return null
    } else if (c === '&') {
      if (command[i + 1] !== '&') return null
      if (!endPipeline()) return null
      i++
    } else if (c === ';') {
      if (!endPipeline()) return null
      if (/^[ \t]*$/.test(command.slice(i + 1))) return pipelines
    } else if (UNQUOTED_REFUSED.has(c)) {
      return null
    } else {
      if (c === '*' || c === '?') glob = true
      word += c
      inWord = true
    }
  }
  if (!endPipeline()) return null
  return pipelines
}

// Allowed flags per program. Anything not listed (an unknown flag, a GNU long-option abbreviation,
// a cluster with one bad letter) makes the command ask. A deny list cannot keep up with GNU and
// BSD option sets; this list only has to be right about what it names.
interface Spec {
  /** Short flags that take no value. */
  chars?: string
  /** Short flags that take a value, attached (`-k2`) or as the next word (`-k 2`). The value is never a path. */
  vals?: string
  /** Long flags: true when they take a value (`--glob=x` or `--glob x`). */
  long?: Record<string, boolean>
  /** `-50` as a line count. */
  count?: boolean
  /** Operands: paths it reads; `pattern` = the first operand is a pattern; `none` = no operands. */
  operands: 'paths' | 'pattern' | 'none'
  /** Reads its operand folders recursively, or the current folder when there is none. */
  recursive?: (flags: string) => boolean
}

const SPECS: Record<string, Spec> = {
  ls: { chars: 'alhtrSdF1AGR', operands: 'paths', recursive: (f) => f.includes('R') },
  cat: { chars: 'nbs', operands: 'paths' },
  head: { vals: 'n', count: true, operands: 'paths' },
  tail: { vals: 'n', count: true, operands: 'paths' },
  wc: { chars: 'lwcm', operands: 'paths' },
  grep: {
    chars: 'nrilvcEFwoHhsqxLI', vals: 'ABCm', long: { include: true, exclude: true, 'exclude-dir': true },
    operands: 'pattern', recursive: (f) => f.includes('r')
  },
  rg: {
    chars: 'nilvcwoHFSsuN', vals: 'gtABCm',
    long: { glob: true, type: true, files: false, hidden: false, 'no-heading': false, 'fixed-strings': false, 'ignore-case': false, 'line-number': false },
    operands: 'pattern', recursive: () => true
  },
  sort: { chars: 'rnufbdhV', vals: 'kt', operands: 'paths' },
  uniq: { chars: 'cdui', operands: 'paths' },
  cut: { vals: 'dfc', operands: 'paths' },
  sed: { chars: 'n', operands: 'paths' },
  pwd: { operands: 'none' },
  which: { operands: 'none' },
  echo: { operands: 'none' }
}

// find: start folders, then only these primaries (each with the number of values it takes).
const FIND_PRIMARIES: Record<string, number> = {
  '-name': 1, '-iname': 1, '-path': 1, '-ipath': 1, '-type': 1, '-maxdepth': 1, '-mindepth': 1, '-size': 1,
  '-print': 0, '-o': 0, '-a': 0, '-not': 0
}

const SED_PRINT = /^[0-9]+(,[0-9]+)?p$/

/** Splits words into flags (checked against the spec) and operands; null on any flag the spec does not allow. */
function splitArgs(spec: Spec, args: string[]): { flags: string; operands: string[] } | null {
  let flags = ''
  const operands: string[] = []
  let ended = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (ended || w === '-' || !w.startsWith('-')) { operands.push(w); continue }
    if (w === '--') { ended = true; continue }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = w.slice(2, eq < 0 ? undefined : eq)
      const takes = spec.long?.[name]
      if (takes === undefined) return null
      if (!takes && eq >= 0) return null
      if (takes && eq < 0) { if (i + 1 >= args.length) return null; i++ }
      continue
    }
    const cluster = w.slice(1)
    if (spec.count && /^[0-9]+$/.test(cluster)) continue
    for (let j = 0; j < cluster.length; j++) {
      const c = cluster[j]!
      if (spec.chars?.includes(c)) { flags += c; continue }
      if (spec.vals?.includes(c)) {
        if (j === cluster.length - 1) { if (i + 1 >= args.length) return null; i++ }
        break
      }
      return null
    }
  }
  return { flags, operands }
}

// `search: true` also refuses a path that contains the agent home: a recursive read would walk into it.
// No `..` at all: path.resolve folds it lexically, but the kernel follows a symlink first.
async function inside(workspace: string, base: string, p: string, home?: string): Promise<boolean> {
  if (p.split('/').includes('..')) return false
  try {
    await resolveInside(workspace, resolve(base, p), home, { search: true })
    return true
  } catch {
    return false
  }
}

// A cd that fails leaves the shell where it was, and after `;` the next command still runs. So the
// target must be a folder the shell can enter, or the base this check tracks would be wrong.
async function enterable(workspace: string, base: string, p: string, home?: string): Promise<string | null> {
  if (!(await inside(workspace, base, p, home))) return null
  const target = resolve(base, p)
  try {
    if (!(await stat(target)).isDirectory()) return null
    await access(target, constants.X_OK)
    return target
  } catch {
    return null
  }
}

/**
 * True only when every command is on the allowlist, uses only allowed flags, and names only paths
 * inside the workspace (and outside the agent home). Without the path rule, `cat ~/.aws/credentials`
 * would bypass the containment the read tool enforces. A grep pattern that looks like a path is also
 * checked: that costs a prompt, never a wrong allow.
 */
export async function isReadOnly(command: string, workspace: string, home?: string): Promise<boolean> {
  const pipelines = parseWords(command)
  if (!pipelines) return false
  let base = workspace
  for (const pipeline of pipelines) {
    for (const segment of pipeline) {
      const words = await expand(segment, workspace, base, home)
      if (!words) return false
      const [program, ...args] = words
      if (program === 'cd') {
        if (pipeline.length !== 1 || args.length !== 1 || args[0]!.startsWith('-')) return false
        const next = await enterable(workspace, base, args[0]!, home)
        if (!next) return false
        base = next
        continue
      }
      if (program === 'find') {
        if (!(await findReadOnly(args, workspace, base, home))) return false
        continue
      }
      const spec = SPECS[program!]
      if (!spec) return false
      const split = splitArgs(spec, args)
      if (!split) return false
      let { operands } = split
      // echo and which read no file: their operands are text and program names.
      if (program === 'echo' || program === 'which') continue
      if (spec.operands === 'none' && operands.length > 0) return false
      if (program === 'sed') {
        if (!split.flags.includes('n') || !operands[0] || !SED_PRINT.test(operands[0])) return false
        operands = operands.slice(1)
      }
      // uniq's second operand is the file it writes.
      if (program === 'uniq' && operands.length > 1) return false
      const paths = spec.operands === 'pattern' ? operands.slice(1) : operands
      for (const a of operands) if (a !== '-' && !(await inside(workspace, base, a, home))) return false
      if (paths.filter((a) => a !== '-').length === 0 && spec.recursive?.(split.flags) && !(await inside(workspace, base, '.', home))) return false
    }
  }
  return true
}

// Expands globs the way sh does for `*` and `?`, so the checks below see the words that will run.
// Null when a glob reads a folder with a name that is not printable ASCII, could leave the workspace, names a dotfile (`.*` also matches `..` in bash 3.2),
// mixes quoted text, or matches a name that starts with `-` (it would become a flag).
async function expand(words: Word[], workspace: string, base: string, home?: string): Promise<string[] | null> {
  const out: string[] = []
  for (const w of words) {
    if (!w.glob) { out.push(w.text); continue }
    const parts = w.text.split('/')
    if (w.quoted || w.text.startsWith('/') || parts.some((p) => p === '..' || p.startsWith('.'))) return null
    let found = ['']
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1
      const next: string[] = []
      for (const prefix of found) {
        if (!/[*?]/.test(part)) { next.push(prefix + part); continue }
        const re = new RegExp('^' + part.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]') + '$')
        let names: string[]
        try { names = await readdir(resolve(base, prefix || '.')) } catch { continue }
        // sh counts `?` in characters or bytes by locale, JS in UTF-16 units, and readdir turns invalid
        // UTF-8 into U+FFFD. Only printable ASCII names match the same way everywhere.
        if (names.some((n) => !/^[\x20-\x7e]+$/.test(n))) return null
        for (const n of names.sort()) if (!n.startsWith('.') && re.test(n)) next.push(prefix + n)
      }
      found = last ? next : next.map((p) => p + '/')
    }
    // sh keeps only paths that exist; with no match it passes the pattern as it is.
    const exists = await Promise.all(found.map((m) => lstat(resolve(base, m)).then(() => true, () => false)))
    found = found.filter((_, i) => exists[i])
    if (found.length === 0) { out.push(w.text); continue }
    for (const m of found) {
      if (m.startsWith('-') || !(await inside(workspace, base, m, home))) return null
      out.push(m)
    }
  }
  return out
}

async function findReadOnly(args: string[], workspace: string, base: string, home?: string): Promise<boolean> {
  let i = 0
  const starts: string[] = []
  while (i < args.length && !args[i]!.startsWith('-')) starts.push(args[i++]!)
  for (; i < args.length; i++) {
    const n = FIND_PRIMARIES[args[i]!]
    if (n === undefined || (n > 0 && i + n >= args.length)) return false
    i += n
  }
  for (const s of starts.length > 0 ? starts : ['.']) if (!(await inside(workspace, base, s, home))) return false
  return true
}
