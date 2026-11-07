import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { create } from "@bufbuild/protobuf";
import { JobAssignmentSchema as ProtoJobSchema } from "@ironflow/core/gen";
import { JobAssignmentSchema, type FunctionContext, type IronflowFunction, type Logger } from "@ironflow/core";
import { serve } from "./serve.js";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";
import { createOTelLogger } from "./logging.js";

const spans = new InMemorySpanExporter();
const traces = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
const logs = new InMemoryLogRecordExporter();
const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logs })] });
const traceId = "12345678901234567890123456789012";
const event = { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() };
type Mode = "push" | "poll" | "stream";

beforeAll(() => { context.disable(); trace.setGlobalTracerProvider(traces); });
afterEach(() => { logs.reset(); spans.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { trace.disable(); await traces.shutdown(); await provider.shutdown(); });

async function execute(mode: Mode, userLogger: Logger | false | undefined, handler: (ctx: FunctionContext) => Promise<unknown>, sampled = true, runId = "run-full-12345678", attempt = 4) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const fn: IronflowFunction = { config: { id: "dispatch-fn", triggers: [] }, handler };
  const carrier = { traceparent: `00-${traceId}-2222222222222222-${sampled ? "01" : "00"}` };
  if (mode === "push") {
    const response = await serve({ functions: [fn], userLogger, logger: false, skipVerification: true })(new Request("http://localhost", {
      method: "POST", headers: carrier,
      body: JSON.stringify({ run_id: runId, function_id: "dispatch-fn", attempt, event, steps: [] }),
    }));
    if (!(response instanceof Response)) throw new Error("Missing response");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed" });
  } else if (mode === "poll") {
    const worker = createWorker({ functions: [fn], userLogger, logger: false, serverUrl: "http://localhost" });
    const job = JobAssignmentSchema.parse({ job_id: "j", run_id: runId, function_id: "dispatch-fn", attempt, event, context: carrier, completed_steps: [] });
    await (worker as unknown as { executeJob(url: string, assignment: typeof job, abort: AbortController): Promise<void> }).executeJob("http://localhost", job, new AbortController());
  } else {
    const worker = createStreamingWorker({ functions: [fn], userLogger, logger: false, serverUrl: "http://localhost" });
    const job = create(ProtoJobSchema, { jobId: "j", runId, functionId: "dispatch-fn", attempt, event: { id: "e", name: "e", data: {} }, context: carrier });
    await (worker as unknown as { executeJob(assignment: typeof job, signal: AbortSignal): Promise<void> }).executeJob(job, new AbortController().signal);
  }
}

it.each<Mode>(["push", "poll", "stream"])("%s enriches default and custom native sinks independently of diagnostics", async mode => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  await execute(mode, undefined, async ({ logger, step }) => step.run("work", async () => logger.info("default")));
  expect(info).toHaveBeenCalledExactlyOnceWith("[ironflow:run-full-12345678]", "default", {
    run_id: "run-full-12345678", function_id: "dispatch-fn", step_id: "run-full-12345678:work:0", attempt: 4, trace_id: traceId,
  });
  const received: Array<Record<string, unknown> | undefined> = [];
  const sink: Logger = { debug() {}, info(_body, data) { received.push(data); }, warn() {}, error() {} };
  await execute(mode, sink, async ({ logger, step }) => step.run("work", async () => logger.info("custom", { attempt: -1, app: "value" })), true, "other-run-12345678", 7);
  expect(received).toEqual([{ run_id: "other-run-12345678", function_id: "dispatch-fn", step_id: "other-run-12345678:work:0", attempt: 7, trace_id: traceId, app: "value" }]);
  await execute(mode, false, async ({ logger }) => { logger.info("silent"); });
  expect(info).toHaveBeenCalledTimes(1);
});

it.each<Mode>(["push", "poll", "stream"])("%s exports each accepted call once with intrinsic context and no console tee", async mode => {
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  await execute(mode, createOTelLogger(provider.getLogger("app")), async ({ logger, step }) => {
    await step.run("work", async () => { await Promise.resolve(); logger.info("hello", { custom: ["a", "b"], attempt: 999 }); });
  });
  const records = logs.getFinishedLogRecords().filter(r => r.body === "hello");
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.attributes).toEqual({ run_id: "run-full-12345678", function_id: "dispatch-fn", step_id: "run-full-12345678:work:0", attempt: 4, trace_id: traceId, custom: ["a", "b"] });
  expect(record.severityNumber).toBe(9);
  expect(record.spanContext?.traceId).toBe(traceId);
  expect(record.spanContext?.spanId).toBe(spans.getFinishedSpans().find(s => s.name === "step.run")?.spanContext().spanId);
  expect(record.spanContext?.traceFlags).toBe(1);
  expect(record.hrTime[0]).toBeGreaterThan(0);
  expect(record.instrumentationScope.name).toBe("app");
  expect(consoleInfo).not.toHaveBeenCalled();
});

it.each<Mode>(["push", "poll", "stream"])("%s correlates valid unsampled context", async mode => {
  await execute(mode, createOTelLogger(provider.getLogger("app")), async ({ logger, step }) => step.run("work", async () => logger.warn("unsampled")), false);
  const record = logs.getFinishedLogRecords().find(r => r.body === "unsampled")!;
  expect(record.attributes.trace_id).toBe(traceId);
  expect(record.spanContext).toMatchObject({ traceId, traceFlags: 0 });
  expect(record.spanContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(record.severityNumber).toBe(13);
  expect(spans.getFinishedSpans()).toHaveLength(0);
});

it("maps levels and explicit errors without adding stacks or swallowing sink exceptions", () => {
  const logger = createOTelLogger(provider.getLogger("app"));
  logger.debug("debug"); logger.info("info"); logger.warn("warn"); logger.error("error", { error: new TypeError("explicit"), nested: { a: 1 } });
  const records = logs.getFinishedLogRecords();
  expect(records.map(r => [r.body, r.severityNumber])).toEqual([["debug", 5], ["info", 9], ["warn", 13], ["error", 17]]);
  expect(records[3]?.attributes).toEqual({ error: { name: "TypeError", message: "explicit" }, nested: { a: 1 } });
  const failure = new Error("sink");
  expect(() => createOTelLogger({ emit() { throw failure; } }).info("fail")).toThrow(failure);
});

it("expires a timed-out child's step label but preserves its inherited intrinsic trace", async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished: Promise<void> | undefined;
  await execute("push", createOTelLogger(provider.getLogger("app")), async ({ logger, step }) => {
    await expect(step.run("timeout", async () => {
      finished = step.run("child", async () => { await gate; logger.info("late-child"); });
      await finished;
    }, { timeout: "5ms" })).rejects.toThrow();
    logger.info("parent-restored");
  });
  release(); await finished;
  const record = logs.getFinishedLogRecords().find(r => r.body === "late-child")!;
  expect(record.attributes.step_id).toBe("");
  expect(record.attributes.trace_id).toBe(traceId);
  expect(record.spanContext?.traceId).toBe(traceId);
  expect(record.spanContext?.spanId).toBe(spans.getFinishedSpans().find(s => s.attributes["ironflow.step.name"] === "child")?.spanContext().spanId);
  expect(logs.getFinishedLogRecords().find(r => r.body === "parent-restored")?.attributes.step_id).toBe("");
});
