import { mkdir, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function agentHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IRONFLOW_AGENT_HOME) return env.IRONFLOW_AGENT_HOME
  return join(env.HOME ?? homedir(), '.ironflow', 'agent')
}

export async function ensureHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask and ignored for an existing dir.
  await chmod(home, 0o700)
}
