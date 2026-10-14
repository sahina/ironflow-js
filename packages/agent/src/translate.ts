import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'
import type { FlueEvent } from '@flue/runtime'
import { mcpLabel, toolKind } from './permissions.js'

export type SessionUpdate = SessionNotification['update']
type Args = Record<string, any> | undefined

// Flue's `tool` end event carries no args, so the diff needs the ones from `tool_start`. The end
// event deletes its entry; the cap bounds entries an aborted turn leaves behind.
const pendingArgs = new Map<string, Args>()
const PENDING_ARGS_CAP = 256
/** Test hook: entries still waiting for their end event. */
export const pendingToolArgsSize = (): number => pendingArgs.size

function title(name: string, args: Args): string {
  const short = mcpLabel(name)
  if (typeof args?.path === 'string') return `${short} ${args.path}`
  if (typeof args?.pattern === 'string') return `${short} ${args.pattern}`
  if (typeof args?.command === 'string') return `${short}: ${args.command.slice(0, 120)}`
  return short
}

// ACP requires absolute paths in locations and diffs; the model sends cwd-relative ones.
const abs = (p: string, cwd: string): string => (isAbsolute(p) ? p : resolve(cwd, p))

export function toSessionUpdate(event: FlueEvent, cwd: string): SessionUpdate | null {
  switch (event.type) {
    case 'text_delta':
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } }
    case 'thinking_delta':
      return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.delta } }
    case 'tool_start': {
      const args: Args = event.args
      if (pendingArgs.size >= PENDING_ARGS_CAP) pendingArgs.delete(pendingArgs.keys().next().value as string)
      pendingArgs.set(event.toolCallId, args)
      return {
        sessionUpdate: 'tool_call', toolCallId: event.toolCallId, title: title(event.toolName, args),
        kind: toolKind(event.toolName), status: 'in_progress', rawInput: args,
        ...(typeof args?.path === 'string' ? { locations: [{ path: abs(args.path, cwd) }] } : {})
      }
    }
    case 'tool': {
      const args = pendingArgs.get(event.toolCallId)
      pendingArgs.delete(event.toolCallId)
      const isEdit = event.toolName === 'edit'
      const newText = isEdit ? args?.newText : args?.content
      const diff = !event.isError && (isEdit || event.toolName === 'write') && typeof args?.path === 'string' && typeof newText === 'string'
        ? [{ type: 'diff' as const, path: abs(args.path, cwd), oldText: isEdit ? args.oldText : null, newText }]
        : undefined
      return {
        sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
        status: event.isError ? 'failed' : 'completed', rawOutput: event.result, ...(diff ? { content: diff } : {})
      }
    }
    default:
      return null
  }
}

function pathOf(uri: string, cwd: string): string {
  try { return relative(cwd, fileURLToPath(uri)) } catch { return uri }
}

export function promptToMessage(blocks: ContentBlock[], cwd: string): string {
  return blocks.map((b) => {
    if (b.type === 'text') return b.text
    if (b.type === 'resource_link') return `@${pathOf(b.uri, cwd)}`
    if (b.type === 'resource') {
      const r = b.resource as { uri: string; text?: string }
      const p = pathOf(r.uri, cwd)
      return typeof r.text === 'string' ? `<file path="${p}">\n${r.text}\n</file>` : `[binary file omitted: ${p}]`
    }
    return `[${b.type} content omitted]`
  }).join('\n\n')
}
