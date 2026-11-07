import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { context, trace } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { createOTelLogger } from "../dist-bundle/index.js";
import { serve } from "../dist-bundle/serve.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiPackage = JSON.parse(readFileSync(join(root, "node_modules/@opentelemetry/api/package.json"), "utf8"));
assert.equal(apiPackage.version, "1.9.0", "compatibility probe must actually load the pinned API");
context.disable();
trace.disable();
const exporter = new InMemoryLogRecordExporter();
const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
try {
  const traceId = "12345678901234567890123456789012";
  const spanId = "2222222222222222";
  const handler = serve({
    skipVerification: true, logger: false,
    userLogger: createOTelLogger(provider.getLogger("package-test")),
    functions: [{ config: { id: "fn" }, handler: async ({ step, logger }) =>
      step.run("work", async () => { logger.info("mixed-imports"); return 42; }) }],
  });
  const response = await handler(new Request("http://localhost", {
    method: "POST", headers: { traceparent: `00-${traceId}-${spanId}-00` },
    body: JSON.stringify({ run_id: "run", function_id: "fn", attempt: 2,
      event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() }, steps: [] }),
  }));
  assert.equal(response.status, 200);
  const records = exporter.getFinishedLogRecords().filter(r => r.body === "mixed-imports");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].attributes, { run_id: "run", function_id: "fn", step_id: "run:work:0", attempt: 2, trace_id: traceId });
  assert.equal(records[0].spanContext?.traceId, traceId);
  assert.equal(records[0].spanContext?.spanId, spanId);
  assert.equal(records[0].spanContext?.traceFlags, 0);
} finally {
  await provider.shutdown();
}

const dir = await mkdtemp(join(tmpdir(), "ironflow-no-otel-types-"));
try {
  const consumer = join(dir, "consumer.mts");
  await writeFile(consumer, `import { serve, createOTelLogger } from ${JSON.stringify(join(root, "dist-bundle/index.js"))};\nvoid serve; void createOTelLogger;\n`);
  const options = { noEmit: true, strict: true, skipLibCheck: false,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, types: ["node"], typeRoots: [join(root, "node_modules/@types")] };
  const host = ts.createCompilerHost(options);
  const hidden = path => /(?:@opentelemetry[\\/]api(?:[\\/]|$)|@opentelemetry\+api@)/.test(path);
  const exists = host.fileExists.bind(host);
  const read = host.readFile.bind(host);
  host.fileExists = path => !hidden(path) && exists(path);
  host.readFile = path => hidden(path) ? undefined : read(path);
  const program = ts.createProgram([consumer], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: p => p, getCurrentDirectory: () => dir, getNewLine: () => "\n",
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("Published mixed imports preserve intrinsic OTel context; declarations work without the optional API.");
