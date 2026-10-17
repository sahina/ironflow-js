import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { BUNDLED_SKILLS, loadSkills, repoSkillsRoot } from '../src/skills.js'

const repoSkills = repoSkillsRoot()!

it('finds the repo skills by source layout, never above an installed dist', () => {
  expect(repoSkillsRoot(resolve('/m/packages/agent/src'))).toBe(resolve('/m/.agents/skills'))
  expect(repoSkillsRoot(resolve('/e/sdk/js/agent/src'))).toBe(resolve('/e/.agents/skills'))
  // A mirror clone in ~: four up from packages/agent/src would be the user's own ~/.agents/skills.
  expect(repoSkillsRoot(resolve('/home/u/ironflow-js/packages/agent/src'))).toBe(resolve('/home/u/ironflow-js/.agents/skills'))
  expect(repoSkillsRoot(resolve('/p/node_modules/@ironflow/agent/dist'))).toBeUndefined()
})

it('loads the five shipped skills from the repo source of truth', async () => {
  const skills = await loadSkills(repoSkills)
  expect(skills.map((s) => s.name)).toEqual([...BUNDLED_SKILLS])
  for (const s of skills) {
    expect(s.description.length).toBeGreaterThan(20)
    expect(s.instructions).not.toMatch(/^---/)
    expect(Object.keys(s.files ?? {}).some((k) => k.startsWith('tests/'))).toBe(false)
  }
})

it('parses a block-scalar description and keeps supporting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ifs-'))
  await mkdir(join(root, 'demo', 'reference'), { recursive: true })
  await writeFile(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: |\n  Line one.\n  Line two.\n---\n\n# Body\n')
  await writeFile(join(root, 'demo', 'reference', 'a.md'), 'A')
  const [s] = await loadSkills(root, ['demo'])
  expect(s).toMatchObject({ name: 'demo', description: 'Line one.\nLine two.', instructions: '# Body\n' })
  expect(s?.files).toEqual({ 'reference/a.md': 'A' })
})

it('fails loud on a skill without a name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ifs-'))
  await mkdir(join(root, 'bad'))
  await writeFile(join(root, 'bad', 'SKILL.md'), '---\ndescription: x\n---\nbody')
  await expect(loadSkills(root, ['bad'])).rejects.toThrow(/bad\/SKILL.md: missing name/)
})
