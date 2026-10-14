import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/bashPolicy.js'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll } from 'vitest'
import { isReadOnly } from '../src/bashPolicy.js'

describe('parseCommand', () => {
  it('splits pipelines on ; and &&, and commands on |', () => {
    expect(parseCommand('cat package.json; ls src')).toEqual([[['cat', 'package.json']], [['ls', 'src']]])
    expect(parseCommand('cd a && grep -n x y | head -20')).toEqual([[['cd', 'a']], [['grep', '-n', 'x', 'y'], ['head', '-20']]])
  })
  it('removes plain quotes and keeps their spaces', () => {
    expect(parseCommand(`grep -n 'a b' "c d"`)).toEqual([[['grep', '-n', 'a b', 'c d']]])
    expect(parseCommand(`echo 'x'"y"z`)).toEqual([[['echo', 'xyz']]])
  })
  it('cannot judge anything outside the grammar', () => {
    for (const c of [
      'ls $(rm x)', 'cat `x`', 'cat a > b', 'cat a >> b', 'cat < a', 'sleep 1 &', 'a || b', '(ls)', '{ ls; }',
      'ls\nrm x', 'ls\rrm', 'ls\vx', 'ls\fx', 'echo "a$b"', 'echo "a`b`"', 'echo "a\\"b"', "echo 'a", 'echo "a',
      'cat <<EOF', 'ls \\; rm', 'ls ~', 'cat ~/x', 'ls # c', '! ls', 'cat src/*.ts', 'ls a?', 'ls [ab]',
      '', '   ', '; ls', 'ls;;', 'ls && ;', ';', 'ls | ', 'ls && && ls', 'ls |& cat'
    ]) {
      expect(parseCommand(c), c).toBeNull()
    }
  })
  it('keeps quoted special characters literal', () => {
    expect(parseCommand(`grep -n '$x|y>z' f`)).toEqual([[['grep', '-n', '$x|y>z', 'f']]])
    expect(parseCommand(`find . -name '*.ts'`)).toEqual([[['find', '.', '-name', '*.ts']]])
  })
})

describe('isReadOnly', () => {
  let ws: string
  let home: string
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ifb-'))
    home = join(ws, '.ironflow', 'agent')
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, 'node_modules', 'x'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(ws, 'my file.ts'), '')
    await symlink('/etc/hosts', join(ws, 'link'))
  })
  const ro = (c: string) => isReadOnly(c, ws, home)

  it('allows reads that stay inside the workspace', async () => {
    for (const c of [
      'cat package.json; ls src', 'cd node_modules/x && grep -n y z', 'sed -n 40,80p f', 'sed -n 5p f',
      "cat 'my file.ts'", 'ls -la', 'pwd', 'which node', 'echo done', 'head -50 a | wc -l',
      "find src -name '*.ts' -type f", "rg -n 'a b' src", 'grep -rn x src', 'sort a | uniq -c | sort -rn',
      'cut -d: -f1 a', 'tail -n 20 a', "grep --include='*.ts' -rn x src", 'grep -n x a'
    ]) {
      expect(await ro(c), c).toBe(true)
    }
  })
  it('refuses writes, code execution, outside paths and unknown programs', async () => {
    for (const c of [
      'cat a; rm b', "sed -n '1p;w out' f", 'sed -n 1p -i f', 'sed -i s/a/b/ f', 'sed -n -e 1p f', 'sed 1p f',
      'find . -delete', 'find . -exec rm x ;', 'find -L .', 'find . -fprint out', 'rg --pre sh x', 'rg -z x', 'rg -L x',
      'grep -R x .', 'sort -o out a', 'sort --compress-program=sh a', 'uniq a b', 'wc --files0-from=list',
      'cat ../../etc/passwd', 'cat /etc/hosts', 'cat link', 'cd .. && cat x', 'cd', 'cd -', 'cd a b',
      'cat .ironflow/agent/credentials.json', 'grep -rn x .ironflow', 'grep --file=/etc/passwd x f',
      'git status', 'env', 'printenv', 'xargs cat', 'awk 1 f', 'node -e 1', 'FOO=1 cat a', './cat a', 'npm test',
      // The agent home is inside this workspace: a recursive read of the base or of an ancestor of the home walks into it.
      'rg x', 'grep -rn x', 'find .', "find . -name '*.ts'", 'ls -R', 'grep -rn x .', 'ls .ironflow'
    ]) {
      expect(await ro(c), c).toBe(false)
    }
  })
})

describe('isReadOnly, review findings', () => {
  let ws: string
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ifr-'))
    const outside = await mkdtemp(join(tmpdir(), 'ifo-'))
    await writeFile(join(outside, '.env'), 'SECRET=1')
    await mkdir(join(ws, 'src'), { recursive: true })
    await writeFile(join(ws, 'a'), '')
    await symlink(outside, join(ws, 'docs'))
  })
  const ro = (c: string) => isReadOnly(c, ws)

  it('refuses flags that write, run a program or follow links, in any spelling', async () => {
    for (const c of [
      'sort -ofile a', 'sort -uo file a', 'sort --out=file a', 'sort --output file a', 'sort --compress=./x -S1k a',
      'rg -nz x src', 'rg -nL x src', 'rg --hostname-bin ./x.sh x src', 'rg --pre=sh x src', 'grep -nR x src',
      'grep -f/etc/hosts x src', 'grep -d recurse key', 'grep --directories=recurse key', 'grep --recur key',
      'tail -f a', 'tail -F a', 'ls -RL', 'ls -L src', 'echo -e x', 'cat -- ../x', 'head -c 5 a', 'find src -newer a'
    ]) {
      expect(await ro(c), c).toBe(false)
    }
  })
  it('refuses a uniq that names an output file, even after -', async () => {
    expect(await ro('echo x | uniq - out.txt')).toBe(false)
    expect(await ro('uniq a out.txt')).toBe(false)
  })
  it('refuses a cd that would not happen, and any .. in a path', async () => {
    for (const c of [
      'cd a/b/c/d; cat ../../../../etc/passwd', 'cd missing && cat x', 'cd a && cat x', 'cat src/../a', 'cat docs/../.env',
      'cat docs/.env', 'cd docs && cat .env'
    ]) {
      expect(await ro(c), c).toBe(false)
    }
  })
  it('still allows the common read-only forms', async () => {
    for (const c of [
      'ls -lr', 'ls -la src', 'cd src && ls', 'grep -n -A3 x src', 'grep -A 3 -n x src', 'grep -rn x src', 'head -n 5 a', 'head -5 a',
      'tail -n 20 a', 'sort -k2 -t, a', 'sort -rn a', 'cut -d: -f1 a', 'cut -d : -f 1 a', 'wc -l a', 'uniq -c a',
      "find src -name '*.ts' -type f -maxdepth 2", "rg -n -g '*.ts' x src", "grep --include='*.ts' -rn x src", 'cat -- a'
    ]) {
      expect(await ro(c), c).toBe(true)
    }
  })
})

describe('stderr redirects (SP3b)', () => {
  it('drops exactly 2>/dev/null and 2>&1', () => {
    expect(parseCommand('cat a 2>/dev/null')).toEqual([[['cat', 'a']]])
    expect(parseCommand('cat a 2>&1 | head')).toEqual([[['cat', 'a'], ['head']]])
    expect(parseCommand('cat a 2>/dev/null; ls')).toEqual([[['cat', 'a']], [['ls']]])
  })
  it('refuses every other redirect', () => {
    for (const c of ['cat a 2>out', 'cat a 2> /dev/null', 'cat a 1>/dev/null', 'cat a >/dev/null', 'cat a2>/dev/null', 'cat a 2>/dev/nullx', "cat a '2>/dev/null'x"]) {
      expect(parseCommand(c), c).not.toEqual([[['cat', 'a']]])
    }
    for (const c of ['cat a 2>out', 'cat a 2> /dev/null', 'cat a 1>/dev/null', 'cat a >/dev/null', 'cat a2>/dev/null', 'cat a 2>/dev/nullx']) {
      expect(parseCommand(c), c).toBeNull()
    }
  })
  it('still refuses a glob in parseCommand, so a glob command gets no session grant', () => {
    expect(parseCommand('rm *.log')).toBeNull()
  })
})

describe('isReadOnly, globs (SP3b)', () => {
  let ws: string
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ifg-'))
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, 'dist'), { recursive: true })
    await mkdir(join(ws, 'evil'), { recursive: true })
    await writeFile(join(ws, 'src', 'a.ts'), '')
    await writeFile(join(ws, 'src', 'b.ts'), '')
    await writeFile(join(ws, 'src', '.hidden.ts'), '')
    await writeFile(join(ws, 'dist', 'x.d.ts'), '')
    await writeFile(join(ws, 'evil', '-ofoo'), '')
    await writeFile(join(ws, 'evil', 'a'), '')
    await symlink('/etc', join(ws, 'out'))
    await mkdir(join(ws, 'mixed'), { recursive: true })
    await symlink('/etc/hosts', join(ws, 'mixed', 'z-link'))
    await writeFile(join(ws, 'mixed', 'a'), '')
  })
  const ro = (c: string) => isReadOnly(c, ws)

  it('allows a glob whose every match is inside the workspace', async () => {
    for (const c of [
      'cat src/*.ts', 'cat src/*.ts | head -50', 'find src; cat src/* 2>/dev/null', 'grep -n x dist/*.d.ts 2>&1 | head',
      'cat src/?.ts', 'cd src && cat *.ts', 'cat */a.ts', 'ls nomatch*'
    ]) {
      expect(await ro(c), c).toBe(true)
    }
  })
  it('refuses a glob that can leave the workspace, match a flag or a dotfile, or mixes quotes', async () => {
    for (const c of [
      'cat ../*', 'cat /etc/*', 'cat ~/x*', 'cat out/*', 'cat mixed/*', 'cd evil && sort *', 'cat .*', 'cat src/.*',
      "cat 'src'/*", 'cat "s"rc/*', 'ls [ab]', 'cat x 2>out', 'cat x 1>/dev/null', 'cat x 2> /dev/null', 'cat x >/dev/null'
    ]) {
      expect(await ro(c), c).toBe(false)
    }
  })
})

describe('isReadOnly, glob over names sh may count differently (SP3b review)', () => {
  it('refuses a glob in a folder with a non-ASCII name, since sh and JS can disagree on what it matches', async () => {
    for (const [name, cmd] of [['😀', 'cat ?'], ['😀', 'head -n 5 ?'], ['é', 'cat ??'], ['é', 'cat *']] as const) {
      const ws = await mkdtemp(join(tmpdir(), 'ifu-'))
      await symlink('/etc/hosts', join(ws, name))
      expect(await isReadOnly(cmd, ws), `${name} ${cmd}`).toBe(false)
    }
  })
})

describe('parseCommand, trailing ; and backslashes in double quotes (SP3b eval)', () => {
  it('accepts one trailing ;', () => {
    expect(parseCommand('ls;')).toEqual([[['ls']]])
    expect(parseCommand('cd a; ls; ')).toEqual([[['cd', 'a']], [['ls']]])
  })
  it('keeps a backslash in double quotes when sh keeps it', () => {
    expect(parseCommand('grep -n "a\\|b" f')).toEqual([[['grep', '-n', 'a\\|b', 'f']]])
    expect(parseCommand('grep -v "^\\s*\\*" f')).toEqual([[['grep', '-v', '^\\s*\\*', 'f']]])
  })
  it('refuses a backslash that sh would treat as an escape in double quotes', () => {
    for (const c of ['echo "a\\$b"', 'echo "a\\`b"', 'echo "a\\\\b"', 'echo "a\\"b"', 'echo "a\\']) {
      expect(parseCommand(c), c).toBeNull()
    }
  })
  it('lets the eval reads run with no prompt', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ife-'))
    await mkdir(join(ws, 'dist'), { recursive: true })
    await writeFile(join(ws, 'dist', 'a.d.ts'), '')
    for (const c of ['cd dist; ls; grep -n "createWorker" -r *.d.ts | head; ', 'cat dist/a.d.ts | grep -v "^\\s*\\*\\|/\\*\\*"']) {
      expect(await isReadOnly(c, ws), c).toBe(true)
    }
  })
})
