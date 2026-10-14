import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentHomeError, OutsideWorkspaceError, resolveInside } from '../src/sandbox/contain.js'

let ws: string
let outside: string
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ifc-'))
  ws = join(base, 'ws'); outside = join(base, 'out')
  await mkdir(ws); await mkdir(outside)
  await writeFile(join(outside, 'secret'), 's')
})

it('resolves a relative path inside the workspace', async () => {
  expect(await resolveInside(ws, 'src/a.ts')).toMatch(/ws\/src\/a\.ts$/)
})
it('accepts an absolute path inside the workspace', async () => {
  expect(await resolveInside(ws, join(ws, 'b'))).toMatch(/ws\/b$/)
})
it('accepts the workspace root itself', async () => {
  expect(await resolveInside(ws, '.')).toMatch(/ws$/)
})
it('rejects .. escapes', async () => {
  await expect(resolveInside(ws, '../out/secret')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects an absolute path outside', async () => {
  await expect(resolveInside(ws, join(outside, 'secret'))).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a symlink that points outside', async () => {
  await symlink(outside, join(ws, 'link'))
  await expect(resolveInside(ws, 'link/secret')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a not-yet-created file under a symlinked parent that points outside', async () => {
  await symlink(outside, join(ws, 'link'))
  await expect(resolveInside(ws, 'link/new/file.txt')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a sibling dir that shares the prefix', async () => {
  await mkdir(`${ws}-evil`)
  await expect(resolveInside(ws, `${ws}-evil/x`)).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a dangling symlink whose target is outside', async () => {
  await symlink(join(outside, 'new'), join(ws, 'dangling'))
  await expect(resolveInside(ws, 'dangling')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a path under a dangling symlink whose target is outside', async () => {
  await symlink(join(outside, 'newdir'), join(ws, 'dangling'))
  await expect(resolveInside(ws, 'dangling/f')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('accepts a dangling symlink whose target is inside', async () => {
  await symlink(join(ws, 'later'), join(ws, 'dangling'))
  expect(await resolveInside(ws, 'dangling')).toMatch(/ws\/later$/)
})
it('rejects a dangling chain that ends outside', async () => {
  await symlink(join(outside, 'new'), join(ws, 'second'))
  await symlink(join(ws, 'second'), join(ws, 'first'))
  await expect(resolveInside(ws, 'first')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})
it('rejects a symlink loop instead of hanging', async () => {
  await symlink(join(ws, 'b'), join(ws, 'a'))
  await symlink(join(ws, 'a'), join(ws, 'b'))
  await expect(resolveInside(ws, 'a')).rejects.toThrow()
})
it('rejects a relative symlink read through a symlinked directory that leaves the workspace', async () => {
  // ws/linkdir -> out/sub, and out/sub/dangling -> ../x. Lexically that is ws/x; the OS resolves out/x.
  await mkdir(join(outside, 'sub'))
  await symlink(join(outside, 'sub'), join(ws, 'linkdir'))
  await symlink('../x', join(outside, 'sub', 'dangling'))
  await expect(resolveInside(ws, 'linkdir/dangling')).rejects.toBeInstanceOf(OutsideWorkspaceError)
})

describe('agent home inside the workspace', () => {
  let home: string
  beforeEach(async () => {
    home = join(ws, '.ironflow', 'agent')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'credentials.json'), '{}')
  })
  it('refuses the home, its files and a not-yet-created file under it', async () => {
    for (const p of ['.ironflow/agent', '.ironflow/agent/credentials.json', '.ironflow/agent/sessions/new.jsonl']) {
      await expect(resolveInside(ws, p, home)).rejects.toBeInstanceOf(AgentHomeError)
    }
  })
  it('refuses a symlink that points into the home', async () => {
    await symlink(join(home, 'credentials.json'), join(ws, 'innocent'))
    await expect(resolveInside(ws, 'innocent', home)).rejects.toBeInstanceOf(AgentHomeError)
  })
  it('still accepts a sibling that shares the prefix', async () => {
    expect(await resolveInside(ws, '.ironflow/agent-notes', home)).toMatch(/agent-notes$/)
  })
  it('names the real cause for a search root that contains the home', async () => {
    await expect(resolveInside(ws, '.', home, { search: true })).rejects.toThrow(/^search root \. contains the agent home .*; search a narrower path$/)
  })
  it('keeps the plain message for a path inside the home', async () => {
    await expect(resolveInside(ws, '.ironflow/agent/credentials.json', home)).rejects.toThrow(/^path inside the agent home: \.ironflow\/agent\/credentials\.json$/)
  })
  it('stays an OutsideWorkspaceError, so exists() and callers keep rethrowing it', async () => {
    await expect(resolveInside(ws, '.ironflow/agent/credentials.json', home)).rejects.toBeInstanceOf(OutsideWorkspaceError)
  })
})
