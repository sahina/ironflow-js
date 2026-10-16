import {
  createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool,
  sandboxFromDriver, useInstruction, useMcpConnection, useModel, useSandbox, useSkill,
  type AgentProps, type SandboxFactory, type SkillDefinition
} from '@flue/runtime'
import { wrapTools, type AgentTool } from './permissions.js'
import { createAcpDriver } from './sandbox/acpDriver.js'
import { resolveInside } from './sandbox/contain.js'
import { getSession, type SessionContext } from './sessions.js'

export const ROLE_PROMPT = [
  'You are the Ironflow agent. You build applications on Ironflow: functions with durable steps,',
  'event triggers, sagas, entity streams, projections, push functions and pull workers.',
  'Before you write Ironflow code, activate the ironflow-code skill. For a new project, activate',
  'ironflow-start first. For exact SDK signatures, fetch the docs URLs that ironflow-docs lists with',
  '`curl -sL <url>` in bash; never guess an API.',
  'The Ironflow skills are packaged with you. A path such as `~/.agents/skills/<skill>/<file>` names',
  'that skill\'s packaged resource: activate the skill and read the file with read_skill_resource.',
  'Do not read ~/.agents/skills with bash or read: a copy there can be a different version, or missing.',
  'Step IDs must be stable and unique: durable steps are memoized by ID.',
  'Prefer the Ironflow MCP tools to inspect functions, runs and events on the running server.',
  'After a change, run the project typecheck and tests with bash, and fix what fails.',
  'Never run a server in the foreground: bash waits for the command to exit. Start one with',
  '`nohup ironflow serve --dev > .ironflow-dev.log 2>&1 &` and read the log file.',
  'Work only inside the workspace. If the user declines a tool call, do not retry it.'
].join('\n')

let skills: SkillDefinition[] = []
export function setSkills(s: SkillDefinition[]): void { skills = s }

// Flue builds grep and glob on env.exec, which sees a shell command and checks only its cwd, so the
// driver never sees their `path`. Resolve it here, and hand the tool the absolute result: a path
// that starts with `-` can then not be read as an option by find or grep.
function confineSearch(tool: AgentTool, s: SessionContext): AgentTool {
  return {
    ...tool,
    async execute(toolCallId: string, params: unknown, ...rest: unknown[]) {
      const p = (params ?? {}) as { path?: string }
      const path = await resolveInside(s.cwd, p.path || '.', s.home, { search: true })
      return (tool.execute as (...a: unknown[]) => unknown)(toolCallId, { ...p, path }, ...rest)
    }
  } as AgentTool
}

// One factory per session, so each closes over its own session's gate. A shared factory would
// need to know which session `tools(sandbox)` is for, and Flue does not pass the id there.
const factories = new Map<string, SandboxFactory>()

function sandboxFor(s: SessionContext): SandboxFactory {
  let f = factories.get(s.id)
  if (!f) {
    f = {
      async createSandbox() {
        return sandboxFromDriver(createAcpDriver({ cwd: s.cwd, sessionId: s.id, client: s.client, caps: s.caps, home: s.home, log: (m) => process.stderr.write(`[agent] ${m}\n`) }), s.cwd)
      },
      tools(sb) {
        return wrapTools([
          createReadTool(sb), createWriteTool(sb), createEditTool(sb), createBashTool(sb),
          confineSearch(createGlobTool(sb) as AgentTool, s), confineSearch(createGrepTool(sb) as AgentTool, s)
        ], s.gate, s.cwd)
      }
    }
    factories.set(s.id, f)
  }
  return f
}

/** session/load re-creates the SessionContext; drop the factory that closed over the old one. */
export function forgetSandbox(id: string): void { factories.delete(id) }

// Runs once per model turn, not per submission: keep network calls and other slow work out.
export function IronflowAgent({ id }: AgentProps): string {
  const s = getSession(id)
  useModel(s.model)
  useSandbox(sandboxFor(s), { cwd: s.cwd })
  for (const skill of skills) useSkill(skill)
  if (s.mcp) useMcpConnection(s.mcp)
  for (const extra of s.extraMcp) useMcpConnection({ ...extra, optional: true })
  if (s.notice) useInstruction(`Tell the user once, at the start of your reply: ${s.notice}`)
  return ROLE_PROMPT
}
IronflowAgent.agentName = 'ironflow-agent'
