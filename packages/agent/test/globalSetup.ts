import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

// The child-process tests run dist/cli.js. Building once here keeps two test files from racing
// on dist/ (copy-skills wipes dist/skills).
export default function setup(): void {
  execSync('pnpm build', { cwd: resolve(import.meta.dirname, '..'), stdio: 'pipe' })
}
