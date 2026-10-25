// Retry policy as the JS SDK sees it: what registration sends, what a handler
// can read about its budget, how a retry delay reaches the engine, and when a
// failed attempt compensates. Converted from the coverage-audit repro
// cov_retry_sdk_js.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IronflowError,
  NonRetryableError,
  RetryAfterError,
  type FunctionContext,
  type IronflowFunction,
} from "@ironflow/core";
import type { WorkerMessage as StreamMessage } from "@ironflow/core/gen";
import { validateResilienceConfig } from "./internal/retry.js";
import { registerFunctions } from "./internal/register-functions.js";
import { createClient } from "./client.js";
import { serve } from "./serve.js";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const pushBody = (over: Record<string, unknown> = {}) => ({
  run_id: "run-1",
  function_id: "fn",
  attempt: 3,
  max_attempts: 3,
  on_exhausted: "fail",
  event: { id: "evt-1", name: "e", data: {}, timestamp: "2024-01-01T00:00:00Z" },
  steps: [],
  ...over,
});
const post = (body: unknown) =>
  new Request("http://localhost:9123/api/ironflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const mkFn = (handler: (ctx: FunctionContext) => Promise<unknown>) =>
  ({ config: { id: "fn" }, handler }) as unknown as IronflowFunction;

interface PushFailure {
  status: string;
  error: { retryable: boolean; retry_after_ms?: number; code?: string };
}
async function push(fn: IronflowFunction, over: Record<string, unknown> = {}) {
  const res = (await serve({ functions: [fn], logger: false })(post(pushBody(over)))) as Response;
  return (await res.json()) as PushFailure;
}

afterEach(() => vi.unstubAllGlobals());

describe("registration sends only what the user set", () => {
  async function registered(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }),
    );
    await registerFunctions({
      baseUrl: "http://localhost:9123",
      functions: new Map([["fn", { config: { id: "fn", triggers: [], ...config }, handler: async () => undefined } as never]]),
      headers: {},
      logger,
    });
    return body;
  }

  it("omits retry, circuitBreaker and throttle when unset", async () => {
    const body = await registered({});
    expect(body).not.toHaveProperty("retry");
    expect(body).not.toHaveProperty("circuitBreaker");
    expect(body).not.toHaveProperty("throttle");
  });

  it("sends retry.onExhausted with the other retry fields", async () => {
    const body = await registered({ retry: { maxAttempts: 7, onExhausted: "fail" } });
    expect(body.retry).toEqual({ maxAttempts: 7, onExhausted: "fail" });
  });

  it("sends circuitBreaker and throttle in the RegisterFunction body shape", async () => {
    const body = await registered({
      circuitBreaker: { failureThreshold: 3, openDurationMs: 1000, maxOpenDurationMs: 8000 },
      throttle: { limit: 10, periodMs: 60000, key: "customerId" },
    });
    expect(body.circuitBreaker).toEqual({ failureThreshold: 3, openDurationMs: 1000, maxOpenDurationMs: 8000 });
    expect(body.throttle).toEqual({ limit: 10, periodMs: 60000, key: "customerId" });
  });

  it("sends only the circuit breaker fields that were set, and no empty key", async () => {
    const body = await registered({
      circuitBreaker: { failureThreshold: 2 },
      throttle: { limit: 1, periodMs: 1000 },
    });
    expect(body.circuitBreaker).toEqual({ failureThreshold: 2 });
    expect(body.throttle).toEqual({ limit: 1, periodMs: 1000 });
  });

  it("client.registerFunction sends the same fields", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ created: true });
      }),
    );
    await createClient({ serverUrl: "http://localhost:9123" }).registerFunction({
      id: "fn",
      triggers: [{ event: "e" }],
      retry: { onExhausted: "pause" },
      circuitBreaker: { openDurationMs: 5000 },
      throttle: { limit: 2, periodMs: 2000 },
    });
    expect(body.retry).toEqual({ onExhausted: "pause" });
    expect(body.circuitBreaker).toEqual({ openDurationMs: 5000 });
    expect(body.throttle).toEqual({ limit: 2, periodMs: 2000 });
  });

  it("client.registerFunction rejects a throttle the server would reject", async () => {
    await expect(
      createClient({ serverUrl: "http://localhost:9123" }).registerFunction({
        id: "fn",
        throttle: { limit: 0, periodMs: 1000 },
      }),
    ).rejects.toThrow(/throttle.limit/);
  });
});

describe("throttle key validation", () => {
  it.each(["$.", ".a", "a.", "a..b"])("rejects the key %j", async (key) => {
    await expect(
      createClient({ serverUrl: "http://localhost:9123" }).registerFunction({
        id: "fn",
        throttle: { limit: 1, periodMs: 1000, key },
      }),
    ).rejects.toThrow(/throttle\.key/);
  });

  it.each(["customerId", "$.data.customerId", "data.customer.id"])("accepts the key %j", (key) => {
    expect(() => validateResilienceConfig({ id: "fn", throttle: { limit: 1, periodMs: 1000, key } })).not.toThrow();
  });
});

describe("RetryAfterError", () => {
  it("is a retryable IronflowError that carries the delay", () => {
    const err = new RetryAfterError("rate limited", 30_000);
    expect(err).toBeInstanceOf(IronflowError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.code).toBe("RETRY_AFTER");
  });

  it("rounds a fractional delay up and treats a non-positive or non-finite one as no hint", () => {
    expect(new RetryAfterError("x", 1.2).retryAfterMs).toBe(2);
    for (const bad of [0, -1, Number.NaN, Infinity, -Infinity]) {
      const err = new RetryAfterError("x", bad);
      expect(err.retryAfterMs).toBe(0);
      expect(err.retryable).toBe(true);
    }
  });
});

describe("push: retry delay on the wire", () => {
  it("carries a handler-supplied retry delay as retry_after_ms", async () => {
    const out = await push(mkFn(async () => { throw new RetryAfterError("rate limited", 30_000); }), { attempt: 1 });
    expect(out.status).toBe("failed");
    expect(out.error.retryable).toBe(true);
    expect(out.error.retry_after_ms).toBe(30_000);
  });

  it("carries the delay of a RetryAfterError thrown inside step.run (wrapped in a StepError)", async () => {
    const out = await push(
      mkFn(async (ctx) => {
        await ctx.step.run("call-api", async () => { throw new RetryAfterError("429", 7000); });
      }),
      { attempt: 1 },
    );
    expect(out.error.retryable).toBe(true);
    expect(out.error.retry_after_ms).toBe(7000);
  });

  it("omits retry_after_ms for an ordinary error", async () => {
    const out = await push(mkFn(async () => { throw new Error("boom"); }), { attempt: 1 });
    expect(out.error).not.toHaveProperty("retry_after_ms");
  });
});

describe("push: RunInfo", () => {
  it("exposes the run's retry budget and exhaustion policy", async () => {
    let seen: FunctionContext["run"] | undefined;
    await push(mkFn(async (ctx) => { seen = ctx.run; return {}; }));
    expect(seen?.attempt).toBe(3);
    expect(seen?.maxAttempts).toBe(3);
    expect(seen?.onExhausted).toBe("fail");
  });

  it("reports an unknown budget as 0 and an unknown policy as empty (older engine)", async () => {
    let seen: FunctionContext["run"] | undefined;
    await push(mkFn(async (ctx) => { seen = ctx.run; return {}; }), { max_attempts: undefined, on_exhausted: undefined });
    expect(seen?.maxAttempts).toBe(0);
    expect(seen?.onExhausted).toBe("");
  });
});

// A handler that completes a step, registers its compensation, then throws.
function compensating(error: () => Error) {
  const undone: string[] = [];
  const fn = mkFn(async (ctx) => {
    await ctx.step.run("charge", async () => "tx");
    ctx.step.compensate("charge", async () => { undone.push("charge"); });
    throw error();
  });
  return { fn, undone };
}

describe("push: compensation on exhaustion", () => {
  it.each([
    ["fail", 3, 3, true],
    ["fail", 4, 3, true],
    ["fail", 2, 3, false],
    ["pause", 3, 3, false],
    ["", 3, 3, false],
    ["fail", 3, 0, false],
  ] as const)("retryable error with on_exhausted=%j at %i/%i compensates=%s", async (onExhausted, attempt, max, want) => {
    const { fn, undone } = compensating(() => new Error("temporary failure"));
    const out = await push(fn, { on_exhausted: onExhausted || undefined, attempt, max_attempts: max || undefined });
    expect(out.error.retryable).toBe(true);
    expect(undone).toEqual(want ? ["charge"] : []);
  });

  it.each(["pause", "fail", ""])("a non-retryable error always compensates (on_exhausted=%j)", async (onExhausted) => {
    const { fn, undone } = compensating(() => new NonRetryableError("nope"));
    await push(fn, { on_exhausted: onExhausted || undefined, attempt: 1 });
    expect(undone).toEqual(["charge"]);
  });

  it("a RetryAfterError on the final attempt under fail compensates and still reports the delay", async () => {
    const { fn, undone } = compensating(() => new RetryAfterError("slow down", 5000));
    const out = await push(fn);
    expect(undone).toEqual(["charge"]);
    expect(out.error.retry_after_ms).toBe(5000);
  });
});

describe("pull (REST) worker", () => {
  interface JobUpdate {
    status: string;
    error?: { retryable: boolean; retry_after_ms?: number };
    steps?: Array<{ type: string }>;
  }

  async function runJob(
    handler: (ctx: FunctionContext) => Promise<unknown>,
    job: Record<string, unknown>,
  ): Promise<{ update: JobUpdate; seen: FunctionContext["run"] | undefined }> {
    let served = false;
    let update: JobUpdate | undefined;
    let seen: FunctionContext["run"] | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "GET" && url.includes("/jobs")) {
          if (served) return new Response(null, { status: 204 });
          served = true;
          return Response.json({
            jobs: [{
              job_id: "job", run_id: "run", function_id: "fn", attempt: 3,
              event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
              completed_steps: [], ...job,
            }],
          });
        }
        if (url.endsWith("/jobs/job")) update = JSON.parse(String(init?.body)) as JobUpdate;
        return Response.json({});
      }),
    );
    const worker = createWorker({
      serverUrl: "http://localhost:9123",
      logger,
      functions: [{
        config: { id: "fn", triggers: [{ event: "e" }] },
        handler: async (ctx: FunctionContext) => { seen = ctx.run; return handler(ctx); },
      }],
    });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(update).toBeDefined(), { timeout: 2000 });
    } finally {
      await worker.stop();
      await running;
    }
    return { update: update!, seen };
  }

  it("reads max_attempts and on_exhausted from the job", async () => {
    const { seen } = await runJob(async () => "ok", { max_attempts: 3, on_exhausted: "fail" });
    expect(seen?.maxAttempts).toBe(3);
    expect(seen?.onExhausted).toBe("fail");
  });

  it("sends retry_after_ms on a failed job", async () => {
    const { update } = await runJob(async () => { throw new RetryAfterError("429", 12_000); }, { max_attempts: 9, on_exhausted: "pause" });
    expect(update.status).toBe("failed");
    expect(update.error?.retryable).toBe(true);
    expect(update.error?.retry_after_ms).toBe(12_000);
  });

  it("omits retry_after_ms for an ordinary error", async () => {
    const { update } = await runJob(async () => { throw new Error("boom"); }, {});
    expect(update.error).not.toHaveProperty("retry_after_ms");
  });

  it("compensates a retryable error on the final attempt under fail", async () => {
    const { fn, undone } = compensating(() => new Error("temporary"));
    const { update } = await runJob(fn.handler as never, { max_attempts: 3, on_exhausted: "fail" });
    expect(update.error?.retryable).toBe(true);
    expect(undone).toEqual(["charge"]);
    expect(update.steps?.some((s) => s.type === "compensate")).toBe(true);
  });

  it("does not compensate on the final attempt under pause", async () => {
    const { fn, undone } = compensating(() => new Error("temporary"));
    await runJob(fn.handler as never, { max_attempts: 3, on_exhausted: "pause" });
    expect(undone).toEqual([]);
  });
});

describe("streaming worker", () => {
  async function sent(
    handler: (ctx: FunctionContext) => Promise<unknown>,
    job: Record<string, unknown>,
  ): Promise<StreamMessage[]> {
    const worker = createStreamingWorker({
      serverUrl: "http://localhost:9123",
      logger,
      functions: [{ config: { id: "fn" }, handler } as unknown as IronflowFunction],
    });
    const out: StreamMessage[] = [];
    (worker as unknown as { sendMessage: (m: StreamMessage) => void }).sendMessage = (m) => out.push(m);
    await (worker as unknown as { executeJob(j: unknown, s: AbortSignal): Promise<void> }).executeJob(
      {
        jobId: "job-1", runId: "run-1", functionId: "fn", attempt: 3,
        executionSeq: 7n, leaseToken: "tok",
        event: { id: "e1", name: "e", data: {}, version: 1, timestamp: undefined },
        completedSteps: [],
        ...job,
      },
      new AbortController().signal,
    );
    return out;
  }
  const failure = (msgs: StreamMessage[]) =>
    msgs.at(-1)!.payload.value as {
      error?: { retryable: boolean; retryAfterMs: bigint };
      steps: Array<{ type: string }>;
    };

  it("sends retryAfterMs on jobFailed", async () => {
    const msgs = await sent(async () => { throw new RetryAfterError("429", 12_000); }, { maxAttempts: 9, onExhausted: "pause" });
    expect(msgs.at(-1)!.payload.case).toBe("jobFailed");
    expect(failure(msgs).error?.retryAfterMs).toBe(12_000n);
  });

  it("sends no delay for an ordinary error", async () => {
    const msgs = await sent(async () => { throw new Error("boom"); }, {});
    expect(failure(msgs).error?.retryAfterMs).toBe(0n);
  });

  it("exposes maxAttempts and onExhausted to the handler", async () => {
    let seen: FunctionContext["run"] | undefined;
    await sent(async (ctx) => { seen = ctx.run; return "ok"; }, { maxAttempts: 3, onExhausted: "fail" });
    expect(seen?.maxAttempts).toBe(3);
    expect(seen?.onExhausted).toBe("fail");
  });

  it("compensates a retryable error on the final attempt under fail", async () => {
    const { fn, undone } = compensating(() => new Error("temporary"));
    const msgs = await sent(fn.handler as never, { maxAttempts: 3, onExhausted: "fail" });
    expect(failure(msgs).error?.retryable).toBe(true);
    expect(undone).toEqual(["charge"]);
    expect(failure(msgs).steps.some((s) => s.type === "compensate")).toBe(true);
  });

  it("does not compensate under pause or with an older engine", async () => {
    for (const job of [{ maxAttempts: 3, onExhausted: "pause" }, { maxAttempts: 0, onExhausted: "" }]) {
      const { fn, undone } = compensating(() => new Error("temporary"));
      await sent(fn.handler as never, job);
      expect(undone).toEqual([]);
    }
  });
});
