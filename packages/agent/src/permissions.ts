import { isAbsolute, resolve } from 'node:path'
import type { AgentSideConnection, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'
import type { SandboxFactory } from '@flue/runtime'
import { isReadOnly, parseCommand } from './bashPolicy.js'

// pi-agent-core is a transitive dependency only; take the type from what Flue hands out.
export type AgentTool = NonNullable<ReturnType<NonNullable<SandboxFactory['tools']>>>[number]

export const IRONFLOW_MCP_SERVER = 'ironflow'

// Allowlist, not denylist: a tool added to internal/mcp later stays hidden until listed here.
export const IRONFLOW_READ_TOOLS = [
  'ironflow_server_info', 'ironflow_overview', 'ironflow_get_docs',
  'ironflow_list_functions', 'ironflow_get_function', 'ironflow_list_projects',
  'ironflow_list_environments', 'ironflow_list_workers', 'ironflow_list_runs',
  'ironflow_get_run', 'ironflow_get_run_steps', 'ironflow_wait_for_run', 'ironflow_list_events',
  'ironflow_list_projections', 'ironflow_projection_status', 'ironflow_rebuild_projection_status',
  'ironflow_list_entity_streams', 'ironflow_read_entity_stream', 'ironflow_kv_list_buckets',
  'ironflow_kv_list_keys', 'ironflow_kv_get'
] as const

export const IRONFLOW_ASK_TOOLS = [
  'ironflow_emit_event', 'ironflow_invoke_function', 'ironflow_append_entity_event',
  'ironflow_resume_run', 'ironflow_rebuild_projection'
] as const

const AUTO_LOCAL = new Set(['read', 'glob', 'grep', 'activate_skill', 'read_skill_resource'])
// Auto-approval trusts the `mcp__ironflow__` prefix: server.ts must drop any host MCP server whose sanitized name is `ironflow`.
const AUTO_MCP = new Set<string>(IRONFLOW_READ_TOOLS.map((t) => `mcp__${IRONFLOW_MCP_SERVER}__${t}`))
// Flue appends `task` outside SandboxFactory.tools, and nothing proves a sub-agent's calls reach
// our wrapped tools or interceptor. Approving it could bypass the gate, so it never runs.
const DENY = new Set(['task'])

// The six tools SandboxFactory.tools hands out. wrapTools gates the ones that ask; anything else
// that is not an MCP tool is unknown to this agent.
export const SANDBOX_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'glob', 'grep'])

export const SUBAGENTS_DENIED_MESSAGE = 'sub-agents are not supported'

export type ToolClass = 'auto' | 'ask' | 'deny'

export function classifyTool(name: string): ToolClass {
  if (DENY.has(name)) return 'deny'
  return AUTO_LOCAL.has(name) || AUTO_MCP.has(name) ? 'auto' : 'ask'
}

export function toolKind(name: string): ToolKind {
  if (name === 'read' || name === 'read_skill_resource') return 'read'
  if (name === 'write' || name === 'edit') return 'edit'
  if (name === 'bash') return 'execute'
  if (name === 'glob' || name === 'grep') return 'search'
  if (name.startsWith('mcp__')) return 'fetch'
  return 'other'
}

/**
 * `mcp__<server>__<tool>` as `server: tool`, so a host server cannot pass for `ironflow` in a
 * prompt. Flue joins the two parts with `__`; the server part may hold single underscores.
 */
export function mcpLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]}: ${m[2]}` : name
}

export type PermissionPort = Pick<AgentSideConnection, 'requestPermission'>

export class PermissionDeniedError extends Error {
  constructor(tool: string) {
    super(
      classifyTool(tool) === 'deny'
        ? `${tool} is not available: ${SUBAGENTS_DENIED_MESSAGE}. Do the work yourself with the other tools.`
        : `The user declined ${tool}. Do not retry the same call; ask the user how to proceed.`
    )
    this.name = 'PermissionDeniedError'
  }
}

const commandOf = (rawInput: unknown): string | null => {
  const c = (rawInput as { command?: unknown } | undefined)?.command
  return typeof c === 'string' ? c : null
}

export class PermissionGate {
  private readonly always = new Set<string>()
  // Bash grants cover one exact command text: a prefix grant on `find .` would approve `find . -delete`.
  private readonly commands = new Set<string>()
  private readonly pending = new Set<() => void>()

  constructor(private readonly port: PermissionPort, private readonly sessionId: string, private readonly ws?: { cwd: string; home?: string }) {}

  async check(req: { toolCallId: string; toolName: string; title: string; kind: ToolKind; rawInput?: unknown; content?: ToolCallContent[] }): Promise<boolean> {
    const cls = classifyTool(req.toolName)
    if (cls === 'deny') return false
    if (cls === 'auto' || this.always.has(req.toolName)) return true
    const command = req.toolName === 'bash' ? commandOf(req.rawInput) : null
    // A command with expansion, a redirect or a heredoc may not do the same thing twice: allow once only.
    const grantable = command !== null && parseCommand(command) !== null
    if (command !== null) {
      if (this.ws && (await isReadOnly(command, this.ws.cwd, this.ws.home))) return true
      if (this.commands.has(command)) return true
    }
    const sessionOption = req.toolName !== 'bash'
      ? { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' as const }
      : grantable ? { optionId: 'allow_always', name: 'Allow this exact command this session', kind: 'allow_always' as const } : null
    let cancelled = false
    let cancel!: () => void
    const cancelledP = new Promise<boolean>((resolve) => { cancel = () => { cancelled = true; resolve(false) } })
    this.pending.add(cancel)
    try {
      const answer = this.port.requestPermission({
        sessionId: this.sessionId,
        toolCall: { toolCallId: req.toolCallId, title: req.title, kind: req.kind, status: 'pending', rawInput: req.rawInput, ...(req.content ? { content: req.content } : {}) },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          ...(sessionOption ? [sessionOption] : []),
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
        ]
      }).then(({ outcome }) => {
        if (outcome.outcome !== 'selected') return false
        // A late answer after session/cancel must not leave a standing approval behind.
        if (outcome.optionId === 'allow_always' && !cancelled) {
          if (req.toolName !== 'bash') this.always.add(req.toolName)
          else if (grantable) this.commands.add(command!)
          // A bash allow_always with no offered grant is a client error: it counts as allow once.
        }
        return outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always'
      })
      return await Promise.race([answer, cancelledP])
    } finally {
      this.pending.delete(cancel)
    }
  }

  /** session/cancel: every open prompt resolves as denied. */
  cancelPending(): void {
    for (const c of this.pending) c()
  }
}

const TITLE_COMMAND_MAX = 120

function titleFor(name: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>
  if (typeof p.path === 'string') return `${name} ${p.path}`
  if (typeof p.command === 'string') {
    const cut = p.command.length - TITLE_COMMAND_MAX
    return `${name}: ${p.command.slice(0, TITLE_COMMAND_MAX)}${cut > 0 ? `… (+${cut} chars)` : ''}`
  }
  return name
}

// What the user approves must be what runs: the whole command, and the whole change for a file.
function contentFor(name: string, params: unknown, cwd: string): ToolCallContent[] | undefined {
  const p = (params ?? {}) as Record<string, unknown>
  if (name === 'bash' && typeof p.command === 'string') return [{ type: 'content', content: { type: 'text', text: p.command } }]
  if ((name === 'write' || name === 'edit') && typeof p.path === 'string') {
    const newText = name === 'write' ? p.content : p.newText
    if (typeof newText !== 'string') return undefined
    return [{ type: 'diff', path: isAbsolute(p.path) ? p.path : resolve(cwd, p.path), oldText: name === 'write' ? null : (p.oldText as string | undefined) ?? null, newText }]
  }
  return undefined
}

export function wrapTools(tools: AgentTool[], gate: PermissionGate, cwd = process.cwd()): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId: string, params: unknown, ...rest: unknown[]) {
      const ok = await gate.check({ toolCallId, toolName: tool.name, title: titleFor(tool.name, params), kind: toolKind(tool.name), rawInput: params, content: contentFor(tool.name, params, cwd) })
      if (!ok) throw new PermissionDeniedError(tool.name)
      return (tool.execute as (...a: unknown[]) => unknown)(toolCallId, params, ...rest)
    }
  })) as AgentTool[]
}
