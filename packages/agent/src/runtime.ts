import { join } from 'node:path'
import type { Provider } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { instrument, type FlueExecutionContext, type FlueExecutionOperation, type SkillDefinition } from '@flue/runtime'
import { sqlite, start, type Flue } from '@flue/runtime/node'
import { IronflowAgent, setSkills } from './agent.js'
import { SANDBOX_TOOLS, classifyTool, mcpLabel, toolKind, PermissionDeniedError } from './permissions.js'
import { sessions } from './sessions.js'
import { ensureHome } from './paths.js'

// Last seen args per tool call, so an MCP permission prompt can show what will be sent.
// Only calls the interceptor reads (and deletes) are kept; the cap bounds entries that a
// validation failure or abort leaves behind.
const pendingArgs = new Map<string, unknown>()
const PENDING_ARGS_CAP = 256
export function noteToolArgs(toolCallId: string, toolName: string, args: unknown): void {
  if (!toolName.startsWith('mcp__') || classifyTool(toolName) !== 'ask') return
  if (pendingArgs.size >= PENDING_ARGS_CAP) pendingArgs.delete(pendingArgs.keys().next().value as string)
  pendingArgs.set(toolCallId, args)
}
/** Test hook: entries still waiting for the interceptor. */
export const pendingArgsSize = (): number => pendingArgs.size

/**
 * Sandbox tools are gated in wrapTools (once, so a write is not prompted twice). This gates MCP
 * tools, which never reach the sandbox, and refuses `task`, which Flue appends outside
 * SandboxFactory.tools. Fails closed: an unknown session or a rejected prompt is a decline.
 * A throw here becomes a tool error the model sees; the turn continues.
 */
export async function gateInterceptor<T>(op: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> {
  if (op.type !== 'tool') return next()
  const cls = classifyTool(op.toolName)
  if (cls === 'deny') throw new PermissionDeniedError(op.toolName)
  if (cls === 'auto') return next()
  // Fail closed on a tool this agent has never heard of, instead of trusting that it gated itself.
  if (!op.toolName.startsWith('mcp__') && !SANDBOX_TOOLS.has(op.toolName)) throw new PermissionDeniedError(op.toolName)
  const s = ctx.instanceId ? sessions.get(ctx.instanceId) : undefined
  const rawInput = pendingArgs.get(op.toolCallId)
  pendingArgs.delete(op.toolCallId)
  if (!s) throw new PermissionDeniedError(op.toolName)
  if (!op.toolName.startsWith('mcp__')) return next()
  let ok = false
  try {
    ok = await s.gate.check({ toolCallId: op.toolCallId, toolName: op.toolName, title: mcpLabel(op.toolName), kind: toolKind(op.toolName), rawInput })
  } catch {
    // The editor's request failed; no answer is not consent.
  }
  if (!ok) throw new PermissionDeniedError(op.toolName)
  return next()
}

// Proxy and test hook. Provider.baseUrl alone still sends requests to api.anthropic.com: each
// model carries its own baseUrl, so the catalog must be rewritten too.
export function anthropicAt(baseUrl: string): Provider {
  const base = anthropicProvider()
  return { ...base, baseUrl, getModels: () => base.getModels().map((m) => ({ ...m, baseUrl })) } as Provider
}

export async function startRuntime(opts: { home: string; skills: SkillDefinition[]; providers?: Provider[]; inMemory?: boolean }): Promise<Flue> {
  await ensureHome(opts.home)
  setSkills(opts.skills)
  const override = process.env.IRONFLOW_AGENT_ANTHROPIC_BASE_URL
  const providers = opts.providers ?? (override ? [anthropicAt(override)] : undefined)
  const flue = await start({
    agents: [IronflowAgent],
    ...(opts.inMemory ? {} : { db: sqlite(join(opts.home, 'flue.db')) }),
    ...(providers ? { providers } : {})
  })
  const dispose = instrument({ observe: () => {}, interceptor: gateInterceptor, dispose: () => {} })
  const stop = flue.stop.bind(flue)
  flue.stop = async () => {
    await stop()
    await dispose()
  }
  return flue
}
