import { cp, mkdtemp, rm, mkdir, symlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "ironflow-no-otel-"));
try {
  await cp(join(root, "dist-bundle"), dir, { recursive: true });
  await mkdir(join(dir, "node_modules"));
  await symlink(await realpath(join(root, "node_modules/zod")), join(dir, "node_modules/zod"));
  await writeFile(join(dir, "smoke.mjs"), `
import assert from 'node:assert/strict';
import { serve, createWorker, createOTelLogger } from './index.js';
await assert.rejects(import('@opentelemetry/api'), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('@opentelemetry/api-logs'), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('@opentelemetry/sdk-logs'), { code: 'ERR_MODULE_NOT_FOUND' });
const calls = [];
const userLogger = { debug() {}, info(message, data) { calls.push([message, data]); }, warn() {}, error() {} };
const fn = { config: { id: 'fn' }, handler: async ({ step, logger }) => step.run('work', async () => { logger.info('no-otel', { app: true, step_id: 'spoof' }); return 42; }) };
const worker = createWorker({ functions: [fn], serverUrl: 'http://localhost' });
assert.equal(worker.state, 'idle');
const handler = serve({ functions: [fn], skipVerification: true, userLogger });
const response = await handler(new Request('http://localhost', { method: 'POST', body: JSON.stringify({
  run_id: 'r', function_id: 'fn', attempt: 1, event: { id: 'e', name: 'e', data: {}, timestamp: new Date().toISOString() }, steps: []
}) }));
assert.equal(response.status, 200);
assert.equal((await response.json()).result, 42);
assert.deepEqual(calls, [['no-otel', { app: true, run_id: 'r', function_id: 'fn', step_id: 'r:work:0', attempt: 1, trace_id: '' }]]);
const records = [];
createOTelLogger({ emit(record) { records.push(record); } }).info('explicit');
assert.equal(records.length, 1);
assert.equal(records[0].body, 'explicit');
assert.equal(records[0].context, undefined);
`);
  execFileSync(process.execPath, [join(dir, "smoke.mjs")], { stdio: "inherit", env: { ...process.env, IRONFLOW_NO_DISCOVERY: "1" } });
  console.log("Published bundle imports and executes without OpenTelemetry installed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
