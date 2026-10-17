// Copies the five shipped skills into dist/skills so the published tarball carries them.
// .agents/skills is the source of truth (see .agents/skills/DRIFT.md); never edit dist copies.
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Runs after tsc --build, so the one copy of the layout rule is already in dist.
import { BUNDLED_SKILLS, repoSkillsRoot } from '../dist/skills.js'

const here = dirname(fileURLToPath(import.meta.url))
// scripts/mirror-js-sync.sh copies the skills to the ironflow-js mirror's .agents/skills.
const src = repoSkillsRoot(resolve(here, '../src'))
if (!src || !existsSync(join(src, 'ironflow-start'))) throw new Error(`copy-skills: no .agents/skills for ${here} (looked in ${src})`)
const dest = resolve(here, '../dist/skills')

await rm(dest, { recursive: true, force: true })
for (const name of BUNDLED_SKILLS) {
  await cp(join(src, name), join(dest, name), {
    recursive: true,
    dereference: true,
    filter: (p) => !p.includes(`${name}/tests`)
  })
}
