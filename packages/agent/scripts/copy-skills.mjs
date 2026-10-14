// Copies the five shipped skills into dist/skills so the published tarball carries them.
// .agents/skills is the source of truth (see .agents/skills/DRIFT.md); never edit dist copies.
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// The engine repo has the skills four levels up (sdk/js/agent/scripts); the ironflow-js mirror
// has them three levels up (packages/agent/scripts). scripts/mirror-js-sync.sh copies them there.
const src = ['../../../../.agents/skills', '../../../.agents/skills'].map((p) => resolve(here, p)).find((p) => existsSync(join(p, 'ironflow-start')))
if (!src) throw new Error('copy-skills: .agents/skills not found above ' + here)
const dest = resolve(here, '../dist/skills')
const NAMES = ['ironflow-start', 'ironflow-code', 'ironflow-docs', 'ironflow-ops', 'ironflow-fit']

await rm(dest, { recursive: true, force: true })
for (const name of NAMES) {
  await cp(join(src, name), join(dest, name), {
    recursive: true,
    dereference: true,
    filter: (p) => !p.includes(`${name}/tests`)
  })
}
