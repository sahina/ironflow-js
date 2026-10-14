import { describe, expect, it, vi } from 'vitest'
import { DEV_TOKEN, claimsIronflowNamespace, degradedNotice, ironflowConnection, mcpTarget, probeMcp } from '../src/mcp.js'

describe('mcpTarget', () => {
  it('defaults to the local server and the dev token', () => {
    expect(mcpTarget({})).toEqual({ url: 'http://localhost:9123/api/v1/mcp', token: DEV_TOKEN })
  })
  it('uses IRONFLOW_SERVER_URL and IRONFLOW_API_KEY, trimming a trailing slash', () => {
    expect(mcpTarget({ IRONFLOW_SERVER_URL: 'https://x.io/', IRONFLOW_API_KEY: 'ifkey_1' }))
      .toEqual({ url: 'https://x.io/api/v1/mcp', token: 'ifkey_1' })
  })
  it('treats a blank IRONFLOW_SERVER_URL as unset', () => {
    expect(mcpTarget({ IRONFLOW_SERVER_URL: ' ' }).url).toBe('http://localhost:9123/api/v1/mcp')
  })
})

describe('probeMcp', () => {
  const target = { url: 'http://h/api/v1/mcp', token: 't' }
  const listing = (names: string[]) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: names.map((name) => ({ name })) } }), {
      headers: { 'content-type': 'application/json' }
    })

  it('returns the server tool names from one stateless tools/list call', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      listing(['ironflow_list_runs', 'ironflow_delete_run']))
    expect(await probeMcp(target, f as never)).toEqual({ ok: true, tools: ['ironflow_list_runs', 'ironflow_delete_run'] })
    expect(f).toHaveBeenCalledTimes(1)
    const init = f.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({ authorization: 'Bearer t' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'tools/list' })
  })
  it('reports unauthorized on 401 and 403 without leaking the token', async () => {
    for (const status of [401, 403]) {
      const r = await probeMcp(target, (async () => new Response('no', { status })) as never)
      expect(r).toMatchObject({ ok: false, reason: 'unauthorized' })
      expect(JSON.stringify(r)).not.toContain('"t"')
    }
  })
  it('reports disabled on 404: serve --dev and default servers do not mount the endpoint', async () => {
    const r = await probeMcp(target, (async () => new Response('{"error":"unknown API route"}', { status: 404 })) as never)
    expect(r).toMatchObject({ ok: false, reason: 'disabled' })
  })
  it('reports unreachable on a connection error and on a server error', async () => {
    expect(await probeMcp(target, (async () => { throw new TypeError('fetch failed') }) as never))
      .toMatchObject({ ok: false, reason: 'unreachable' })
    expect(await probeMcp(target, (async () => new Response('x', { status: 502 })) as never))
      .toMatchObject({ ok: false, reason: 'unreachable', detail: 'HTTP 502' })
  })
  it('reports unreachable when the body is not a tools/list result', async () => {
    expect(await probeMcp(target, (async () => new Response('<html>', { status: 200 })) as never))
      .toMatchObject({ ok: false, reason: 'unreachable' })
  })
})

describe('ironflowConnection', () => {
  const target = { url: 'http://h/api/v1/mcp', token: 't' }
  it('mounts only allowlisted tools the server actually has', () => {
    const c = ironflowConnection(target, ['ironflow_list_runs', 'ironflow_emit_event', 'ironflow_delete_run'])
    expect(c).toMatchObject({ name: 'ironflow', url: target.url, auth: 't', optional: true })
    expect(c.tools).toEqual(['ironflow_list_runs', 'ironflow_emit_event'])
  })
  it('drops an allowlisted name the server lacks instead of failing the connection', () => {
    expect(ironflowConnection(target, ['ironflow_list_runs']).tools).toEqual(['ironflow_list_runs'])
  })
})

describe('degradedNotice', () => {
  const t = { url: 'http://localhost:9123/api/v1/mcp', token: 'secret' }
  it('names the cause and the fix', () => {
    expect(degradedNotice(t, { ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' }))
      .toMatch(/no server at http:\/\/localhost:9123.*ironflow serve/s)
    const u = degradedNotice(t, { ok: false, reason: 'unauthorized', detail: '401' })
    expect(u).toMatch(/IRONFLOW_API_KEY/)
    expect(u).not.toContain('secret')
  })
  it('explains that remote MCP is off, and not available under --dev', () => {
    const d = degradedNotice(t, { ok: false, reason: 'disabled', detail: 'HTTP 404' })
    expect(d).toMatch(/IRONFLOW_MCP_REMOTE/)
    expect(d).toMatch(/--dev/)
  })
})

describe('claimsIronflowNamespace', () => {
  it.each(['ironflow', 'Ironflow', 'ironflow.', '_ironflow_', '.ironflow', 'ironflow '])('flags %j', (name) => {
    expect(claimsIronflowNamespace(name)).toBe(true)
  })
  it.each(['docs', 'ironflow-docs', 'ironflow_x', 'my.ironflow', ''])('allows %j', (name) => {
    expect(claimsIronflowNamespace(name)).toBe(false)
  })
})
