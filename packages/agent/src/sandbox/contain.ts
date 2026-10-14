import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class OutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`path outside workspace: ${path}`)
    this.name = 'OutsideWorkspaceError'
  }
}

// A subclass, so exists() and every other `instanceof OutsideWorkspaceError` rethrow covers it.
export class AgentHomeError extends OutsideWorkspaceError {
  constructor(path: string, message?: string) {
    super(path)
    this.name = 'AgentHomeError'
    this.message = message ?? `path inside the agent home: ${path}`
  }
}

const MAX_LINK_HOPS = 40

const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

// Resolve the deepest existing ancestor, so a not-yet-created file under a symlinked
// directory is still checked against where the symlink really points. A dangling symlink
// also fails realpath with ENOENT, but a write through it creates its target, so follow it by hand.
async function realpathLoose(p: string, hops = 0): Promise<string> {
  try {
    return await realpath(p)
  } catch (e) {
    if (!isEnoent(e)) throw e
  }
  if (await lstat(p).then(() => true, (e: unknown) => { if (isEnoent(e)) return false; throw e })) {
    if (hops >= MAX_LINK_HOPS) throw new OutsideWorkspaceError(p)
    // dirname(p) may itself be a symlink, and `..` in the target is relative to where it really points.
    return realpathLoose(resolve(await realpathLoose(dirname(p), hops + 1), await readlink(p)), hops + 1)
  }
  const parent = dirname(p)
  if (parent === p) return p
  return join(await realpathLoose(parent, hops), basename(p))
}

const within = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * `home` holds the provider key, the transcripts and flue.db. When the editor opens an ancestor of
 * it, the workspace check alone would let the file tools read them with no prompt.
 * A search (`grep`, `glob`) also refuses a root that contains the home: it would walk into it.
 */
export async function resolveInside(cwd: string, p: string, home?: string, opts: { search?: boolean } = {}): Promise<string> {
  const root = await realpath(cwd)
  const target = await realpathLoose(isAbsolute(p) ? p : resolve(cwd, p))
  if (!within(root, target)) throw new OutsideWorkspaceError(p)
  if (home) {
    const h = await realpathLoose(home)
    if (within(h, target)) throw new AgentHomeError(p)
    if (opts.search && within(target, h)) throw new AgentHomeError(p, `search root ${p} contains the agent home ${h}; search a narrower path`)
  }
  return target
}
