#!/usr/bin/env node
// Stands in for `ironflow mcp --transport streamable-http`: bearer-checked, stateless JSON on /mcp, port file on bind.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
const mode = process.env.IRONFLOW_FAKE_MODE
// Written before the port file: startBridge returns as soon as that exists.
const record = () => { if (process.env.IRONFLOW_FAKE_RECORD) writeFileSync(process.env.IRONFLOW_FAKE_RECORD, JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), env: process.env })) }
if (process.env.IRONFLOW_MCP_EXIT_ON_STDIN_CLOSE === '1') { process.stdin.on('end', () => process.exit(0)); process.stdin.resume() }
if (mode === 'exit') { process.stderr.write('Error: unknown flag: --static-only\n'); process.exit(2) }
if (mode === 'hang') { record(); setInterval(() => {}, 1000) }
else {
  const token = process.env.IRONFLOW_MCP_BEARER_TOKEN
  const tools = (process.env.IRONFLOW_FAKE_TOOLS ?? 'ironflow_list_runs,ironflow_emit_event').split(',')
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const msg = JSON.parse(body)
      const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'tools/list') reply({ tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) })
      else if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
      else if (msg.method === 'tools/call' && process.env.IRONFLOW_FAKE_ENGINE === 'down') reply({ isError: true, content: [{ type: 'text', text: 'dial tcp 127.0.0.1:9123: connect: connection refused' }] })
      else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: `ran ${msg.params.name} in ${process.cwd()}` }] })
      else res.writeHead(202).end()
    })
  })
  server.listen(0, '127.0.0.1', () => {
    record()
    const text = JSON.stringify({ http_port: server.address().port })
    // A torn write: the reader must treat it as "not yet".
    if (mode === 'torn') { writeFileSync(flag('--port-file'), text.slice(0, 5)); setTimeout(() => writeFileSync(flag('--port-file'), text), 100) }
    else writeFileSync(flag('--port-file'), text)
  })
  process.on('SIGTERM', () => process.exit(0))
}
