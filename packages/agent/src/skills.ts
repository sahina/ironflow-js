import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillDefinition } from '@flue/runtime'
import { parse } from 'yaml'

// Same five as apps/desktop-electron/.flue/agent.ts BUNDLED_SKILLS, in workflow order.
export const BUNDLED_SKILLS = ['ironflow-start', 'ironflow-code', 'ironflow-docs', 'ironflow-ops', 'ironflow-fit'] as const

export function bundledSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'skills')
}

const REPO_LAYOUTS = [join('packages', 'agent', 'src'), join('sdk', 'js', 'agent', 'src')]

// The source-of-truth .agents/skills, for a run from source in the ironflow-js mirror
// (packages/agent/src) or the engine repo (sdk/js/agent/src). Matched by layout, not depth: from an
// installed dist, the .agents/skills above it is the user's own, which can be another version.
export function repoSkillsRoot(srcDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const layout = REPO_LAYOUTS.find((l) => srcDir.endsWith(sep + l))
  return layout && join(srcDir.slice(0, -layout.length), '.agents', 'skills')
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(p)))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

export async function loadSkills(root: string, names: readonly string[] = BUNDLED_SKILLS): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []
  for (const name of names) {
    const dir = join(root, name)
    const raw = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
    const meta = (match ? parse(match[1] ?? '') : {}) as Record<string, unknown>
    if (typeof meta.name !== 'string') throw new Error(`${name}/SKILL.md: missing name`)
    if (typeof meta.description !== 'string') throw new Error(`${name}/SKILL.md: missing description`)
    const files: Record<string, string> = {}
    for (const file of await listFiles(dir)) {
      const rel = relative(dir, file)
      // tests/ are the skill's own CI fixtures; the agent never reads them.
      if (rel === 'SKILL.md' || rel.startsWith('tests/')) continue
      files[rel] = await readFile(file, 'utf8')
    }
    skills.push({
      name: meta.name,
      description: meta.description.trim(),
      instructions: (match?.[2] ?? raw).replace(/^\n+/, ''),
      files
    })
  }
  return skills
}
