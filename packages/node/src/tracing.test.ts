import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { context, trace, ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, ParentBasedSampler, AlwaysOnSampler, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { JobAssignmentSchema as ProtoJobSchema } from "@ironflow/core/gen";
import { JobContextSchema, JobAssignmentSchema, type IronflowFunction, type FunctionContext } from "@ironflow/core";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";
import { serve } from "./serve.js";
import { jobOutputFields } from "./internal/stream-yield.js";
import { traceProcess, traceStep } from "./internal/tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }), spanProcessors: [new SimpleSpanProcessor(exporter)] });
const manager = new AsyncLocalStorageContextManager();
const traceId = "11111111111111111111111111111111";
const parentId = "2222222222222222";
const carrier = { traceparent: `00-${traceId}-${parentId}-01`, tracestate: "vendor=value" };
const event = { id: "e", name: "test", data: {}, timestamp: new Date().toISOString() };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(() => { trace.setGlobalTracerProvider(provider); context.setGlobalContextManager(manager.enable()); });
beforeEach(() => { exporter.reset(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 }))); });
afterAll(async () => { vi.unstubAllGlobals(); trace.disable(); context.disable(); await provider.shutdown(); });

type Mode = "poll" | "stream" | "push";
async function execute(mode: Mode, handler: (ctx: FunctionContext) => Promise<unknown>, options: { carrier?: typeof carrier; replay?: boolean; abort?: AbortController } = {}) {
  const fn = { config: { id: "fn" }, handler } as IronflowFunction;
  const completed = options.replay ? [{ id: "r:cached:0", name: "cached", status: "completed" as const, output: 4 }] : [];
  const injected = options.carrier ?? carrier;
  if (mode === "push") {
    const result = await serve({ functions: [fn], skipVerification: true })(new Request("http://localhost/", {
      method: "POST", headers: injected,
      body: JSON.stringify({ run_id: "r", function_id: "fn", attempt: 1, event, steps: completed }),
    }));
    expect(result).toBeInstanceOf(Response);
    return;
  }
  if (mode === "poll") {
    const worker = createWorker({ functions: [fn], logger, serverUrl: "http://localhost" });
    const job = JobAssignmentSchema.parse({ job_id: "j", run_id: "r", function_id: "fn", attempt: 1, event, context: injected, completed_steps: completed.map(s => ({ ...s, step_id: s.id })) });
    await (worker as unknown as { executeJob(url: string, assignment: typeof job, abort: AbortController): Promise<void> }).executeJob("http://localhost", job, options.abort ?? new AbortController());
    return;
  }
  const worker = createStreamingWorker({ functions: [fn], logger, serverUrl: "http://localhost" });
  const job = create(ProtoJobSchema, {
    jobId: "j", runId: "r", functionId: "fn", attempt: 1,
    event: { id: "e", name: "test", data: {} }, context: injected,
    completedSteps: completed.map(s => ({ stepId: s.id, name: s.name, status: "completed", ...jobOutputFields(4) })),
  } satisfies MessageInitShape<typeof ProtoJobSchema>);
  await (worker as unknown as { executeJob(assignment: typeof job, signal: AbortSignal): Promise<void> }).executeJob(job, (options.abort ?? new AbortController()).signal);
}

describe.each<Mode>(["poll", "stream", "push"])("%s trace continuation", mode => {
  it("parents execution on the carrier without secrets and skips replay spans", async () => {
    const ambient = provider.getTracer("test").startSpan("unrelated");
    await context.with(trace.setSpan(ROOT_CONTEXT, ambient), () => execute(mode, async ({ step }) => {
      expect(trace.getActiveSpan()?.spanContext().traceId).toBe(traceId);
      expect(await step.run("cached", async () => { throw new Error("replayed"); })).toBe(4);
      return step.run("work", async () => "done");
    }, { replay: true }));
    const spans = exporter.getFinishedSpans();
    const process = spans.find(s => s.name === "process");
    const step = spans.find(s => s.name === "step.run");
    expect(spans).toHaveLength(2);
    expect(process?.spanContext().traceId).toBe(traceId);
    expect(process?.parentSpanContext?.spanId).toBe(parentId);
    expect(process?.spanContext().traceState?.serialize()).toBe("vendor=value");
    expect(step?.parentSpanContext?.spanId).toBe(process?.spanContext().spanId);
    ambient.end();
  });

  it("keeps concurrent branch steps under their own process", async () => {
    await execute(mode, async ({ step }) => step.parallel("branches", [
      branch => branch.run("left", async () => { await Promise.resolve(); return 1; }),
      branch => branch.run("right", async () => 2),
    ]));
    const spans = exporter.getFinishedSpans();
    const process = spans.find(s => s.name === "process");
    const steps = spans.filter(s => s.name === "step.run");
    expect(steps).toHaveLength(2);
    expect(steps.every(s => s.parentSpanContext?.spanId === process?.spanContext().spanId)).toBe(true);
  });

  it("records failures and closes both spans without exception messages", async () => {
    await execute(mode, async ({ step }) => step.run("failure", async () => { throw new Error("credential-secret"); }));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.every(s => s.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(JSON.stringify(spans.map(s => s.events))).not.toContain("credential-secret");
  });

  it("ends a yielded process without failure status", async () => {
    await execute(mode, async ({ step }) => step.sleep("pause", "1s"));
    expect(exporter.getFinishedSpans().map(s => [s.name, s.status.code])).toEqual([["process", SpanStatusCode.UNSET]]);
  });

  it("falls back to a root for malformed carriers despite an ambient request", async () => {
    const ambient = provider.getTracer("test").startSpan("unrelated");
    await context.with(trace.setSpan(ROOT_CONTEXT, ambient), () => execute(mode, async () => 1, { carrier: { traceparent: "bad", tracestate: "bad" } }));
    const span = exporter.getFinishedSpans()[0];
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.spanContext().traceId).not.toBe(ambient.spanContext().traceId);
    ambient.end();
  });

  it.each(["vendor=ok,vendor=duplicate", "bad=", "x".repeat(513)])("discards invalid state without losing the parent", async tracestate => {
    await execute(mode, async () => 1, { carrier: { ...carrier, tracestate } });
    const span = exporter.getFinishedSpans()[0];
    expect(span?.parentSpanContext?.spanId).toBe(parentId);
    expect(span?.spanContext().traceState?.serialize() ?? "").toBe("");
  });

  it.each([
    `01-${traceId}-${parentId}-01-${"a".repeat(457)}`,
    `01-${traceId}-${parentId}-01-${"a".repeat(1_000_000)}`,
  ])("starts a root for an oversized parent", async traceparent => {
    await execute(mode, async () => 1, { carrier: { ...carrier, traceparent } });
    expect(exporter.getFinishedSpans()[0]?.parentSpanContext).toBeUndefined();
  });

  it("continues a future-version parent at the input limit", async () => {
    const traceparent = `01-${traceId}-${parentId}-01-${"a".repeat(456)}`;
    expect(traceparent).toHaveLength(512);
    await execute(mode, async () => 1, { carrier: { ...carrier, traceparent } });
    expect(exporter.getFinishedSpans()[0]?.parentSpanContext?.spanId).toBe(parentId);
  });

  it("propagates valid unsampled parents", async () => {
    await execute(mode, async ({ step }) => step.run("work", async () => {
      expect(trace.getActiveSpan()?.spanContext()).toMatchObject({ traceId, traceFlags: 0 });
    }), { carrier: { ...carrier, traceparent: `00-${traceId}-${parentId}-00` } });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

it.each<Mode>(["poll", "stream"])("%s cancellation ends spans without treating abort as a failure", async mode => {
  const abort = new AbortController();
  await execute(mode, async ({ step }) => step.run("cancel", async () => { abort.abort(); throw new Error("cancelled"); }), { abort });
  expect(exporter.getFinishedSpans()).toHaveLength(2);
  expect(exporter.getFinishedSpans().every(s => s.status.code === SpanStatusCode.UNSET)).toBe(true);
});

it("ends cancelled spans even when user work has not settled", async () => {
  const abort = new AbortController();
  let release: () => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const task = traceProcess(carrier, () => traceStep("blocked", abort.signal, () => new Promise<void>(resolve => { release = resolve; markStarted(); })), abort.signal);
  await started;
  abort.abort();
  expect(exporter.getFinishedSpans()).toHaveLength(2);
  release();
  await task;
  expect(exporter.getFinishedSpans()).toHaveLength(2);
});

it("ignores malformed observation fields rather than rejecting business work", () => {
  expect(JobContextSchema.parse({ traceparent: 42, tracestate: {} })).toEqual({ traceparent: undefined, tracestate: undefined });
});
