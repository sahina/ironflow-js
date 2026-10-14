import type { McpConnectionDefinition } from '@flue/runtime'
import type { PermissionGate } from './permissions.js'
import type { AcpFsPort, DriverOptions } from './sandbox/acpDriver.js'

export interface SessionContext {
  id: string
  cwd: string
  /** The agent home, which the file tools must not reach. */
  home: string
  client: AcpFsPort | null
  caps: DriverOptions['caps']
  gate: PermissionGate
  model: string
  mcp: McpConnectionDefinition | null
  /** Connect again before the next prompt: no Ironflow tools yet, or the engine did not answer. */
  mcpRetry: boolean
  extraMcp: McpConnectionDefinition[]
  /** One-time message for the first turn (degraded MCP). Cleared once shown. */
  notice: string | null
}

// Keyed by ACP session id, which is also the Flue instance id.
export const sessions = new Map<string, SessionContext>()

export function getSession(id: string): SessionContext {
  const s = sessions.get(id)
  if (!s) throw new Error(`unknown session ${id}`)
  return s
}
