import { describe, expect, it } from 'vitest'
import { pendingToolArgsSize, promptToMessage, toSessionUpdate } from '../src/translate.js'

const ev = (e: Record<string, unknown>) => ({ v: 3, eventIndex: 0, timestamp: '', ...e }) as never
const CWD = '/w'

describe('toSessionUpdate', () => {
  it.each([
    [{ type: 'text_delta', text: 'hi' }, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }],
    [{ type: 'thinking_delta', delta: 'hm' }, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }],
    [{ type: 'tool_start', toolName: 'read', toolCallId: 'c1', args: { path: 'src/a.ts' } },
     { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read src/a.ts', kind: 'read', status: 'in_progress', rawInput: { path: 'src/a.ts' }, locations: [{ path: '/w/src/a.ts' }] }],
    [{ type: 'tool', toolName: 'bash', toolCallId: 'c2', isError: false, result: 'ok' },
     { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', rawOutput: 'ok' }],
    [{ type: 'tool', toolName: 'bash', toolCallId: 'c3', isError: true, result: 'boom' },
     { sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'failed', rawOutput: 'boom' }]
  ])('%o', (input, expected) => {
    expect(toSessionUpdate(ev(input), CWD)).toEqual(expected)
  })

  it('titles an MCP tool call with its server, so two servers with one tool name differ', () => {
    for (const [name, title] of [['mcp__ironflow__ironflow_get_run', 'ironflow: ironflow_get_run'], ['mcp__evil_co__ironflow_emit_event', 'evil_co: ironflow_emit_event']]) {
      expect(toSessionUpdate(ev({ type: 'tool_start', toolName: name, toolCallId: 'm1', args: {} }), CWD)).toMatchObject({ title })
    }
  })

  it('keeps an absolute path as is', () => {
    expect(toSessionUpdate(ev({ type: 'tool_start', toolName: 'read', toolCallId: 'c5', args: { path: '/etc/hosts' } }), CWD))
      .toMatchObject({ locations: [{ path: '/etc/hosts' }] })
  })

  describe('edit diff (the end event carries no args)', () => {
    it('attaches an absolute-path diff block, with args taken from tool_start', () => {
      toSessionUpdate(ev({ type: 'tool_start', toolName: 'edit', toolCallId: 'e1', args: { path: 'a.ts', oldText: 'x', newText: 'y' } }), CWD)
      const u = toSessionUpdate(ev({ type: 'tool', toolName: 'edit', toolCallId: 'e1', isError: false, result: 'ok' }), CWD)
      expect(u).toMatchObject({ status: 'completed', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' }] })
    })

    it('shows a write as a new-file diff', () => {
      toSessionUpdate(ev({ type: 'tool_start', toolName: 'write', toolCallId: 'w1', args: { path: 'n.ts', content: 'hello' } }), CWD)
      const u = toSessionUpdate(ev({ type: 'tool', toolName: 'write', toolCallId: 'w1', isError: false, result: 'ok' }), CWD)
      expect(u).toMatchObject({ content: [{ type: 'diff', path: '/w/n.ts', oldText: null, newText: 'hello' }] })
    })

    it('attaches no diff to a failed edit', () => {
      toSessionUpdate(ev({ type: 'tool_start', toolName: 'edit', toolCallId: 'e2', args: { path: 'a.ts', oldText: 'x', newText: 'y' } }), CWD)
      const u = toSessionUpdate(ev({ type: 'tool', toolName: 'edit', toolCallId: 'e2', isError: true, result: 'no' }), CWD)
      expect(u).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'e2', status: 'failed', rawOutput: 'no' })
    })

    it('deletes the remembered args after the end event', () => {
      const before = pendingToolArgsSize()
      toSessionUpdate(ev({ type: 'tool_start', toolName: 'edit', toolCallId: 'e3', args: { path: 'a.ts' } }), CWD)
      expect(pendingToolArgsSize()).toBe(before + 1)
      toSessionUpdate(ev({ type: 'tool', toolName: 'edit', toolCallId: 'e3', isError: false }), CWD)
      expect(pendingToolArgsSize()).toBe(before)
    })

    it('caps the remembered args so aborted turns cannot grow the map', () => {
      for (let i = 0; i < 1000; i++) toSessionUpdate(ev({ type: 'tool_start', toolName: 'write', toolCallId: `cap${i}`, args: { path: 'a', content: 'c' } }), CWD)
      expect(pendingToolArgsSize()).toBe(256)
      // the oldest entry was evicted, the newest survives
      const oldest = toSessionUpdate(ev({ type: 'tool', toolName: 'write', toolCallId: 'cap0', isError: false }), CWD)
      const newest = toSessionUpdate(ev({ type: 'tool', toolName: 'write', toolCallId: 'cap999', isError: false }), CWD)
      expect(oldest).not.toHaveProperty('content')
      expect(newest).toMatchObject({ content: [{ type: 'diff' }] })
      expect(pendingToolArgsSize()).toBe(255)
    })
  })

  it('ignores bookkeeping events', () => {
    for (const type of ['turn_start', 'message_start', 'submission_queued', 'idle', 'log']) {
      expect(toSessionUpdate(ev({ type }), CWD)).toBeNull()
    }
  })
})

describe('promptToMessage', () => {
  it('joins text and inlines embedded resources with their path', () => {
    expect(promptToMessage([
      { type: 'text', text: 'Fix this' },
      { type: 'resource', resource: { uri: 'file:///w/src/a.ts', text: 'let x' } }
    ] as never, '/w')).toBe('Fix this\n\n<file path="src/a.ts">\nlet x\n</file>')
  })
  it('turns a resource link into an @path reference', () => {
    expect(promptToMessage([{ type: 'resource_link', uri: 'file:///w/b.ts', name: 'b.ts' }] as never, '/w')).toBe('@b.ts')
  })
  it('notes a binary resource instead of inlining it', () => {
    expect(promptToMessage([{ type: 'resource', resource: { uri: 'file:///w/i.png', blob: 'AAAA', mimeType: 'image/png' } }] as never, '/w'))
      .toBe('[binary file omitted: i.png]')
  })
  it('does not crash on a non-file uri or an unknown block', () => {
    expect(promptToMessage([
      { type: 'resource_link', uri: 'https://example.com/x', name: 'x' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ] as never, '/w')).toBe('@https://example.com/x\n\n[image content omitted]')
  })
})
