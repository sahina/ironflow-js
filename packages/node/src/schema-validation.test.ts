import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { IronflowFunction } from "@ironflow/core";
import { createFunction } from "./function.js";
import { serve } from "./serve.js";
import { createWorker } from "./worker.js";
import { validateEventData } from "./internal/validate-event.js";
import { createTestClient } from "./test/index.js";

// #1948: a declared `schema` on FunctionConfig is enforced at runtime on every
// execution path (serve, createWorker, the test harness; createStreamingWorker
// shares the helper but its suite drives a mock). Undeclared schema is a no-op;
// a mismatch fails the run non-retryably; a match hands the handler the
// *parsed* Zod output; cron ticks are exempt.

const schema = z.object({ orderId: z.string(), qty: z.number().default(1) });

const CRON_TICK = { type: "cron", expression: "* * * * *" };

function pushBody(data: unknown, functionId: string, source?: string) {
  return {
    run_id: "run_1",
    function_id: functionId,
    attempt: 1,
    event: { id: "evt_1", name: "order.placed", data, timestamp: "2024-01-01T00:00:00Z", source },
    steps: [],
  };
}

async function push(fn: IronflowFunction<any, any>, data: unknown, source?: string) {
  const handler = serve({ functions: [fn], skipVerification: true, logger: false });
  const res = (await handler(
    new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pushBody(data, fn.config.id, source)),
    })
  )) as Response;
  return (await res.json()) as Record<string, any>;
}

describe("FunctionConfig.schema — push (serve)", () => {
  const typed = createFunction(
    { id: "typed", triggers: [{ event: "order.placed" }], schema },
    async ({ event }) => event.data
  );
  const untyped = createFunction(
    { id: "untyped", triggers: [{ event: "order.placed" }] },
    async ({ event }) => event.data
  );

  it("passes parsed data (defaults applied) to the handler", async () => {
    const body = await push(typed, { orderId: "o1" });
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ orderId: "o1", qty: 1 });
  });

  it("fails the run non-retryably on a mismatch", async () => {
    const body = await push(typed, { orderId: 42 });
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("orderId");
    expect(body.error.message).toContain("typed");
  });

  it("skips cron ticks on the wire", async () => {
    const body = await push(typed, CRON_TICK, "cron");
    expect(body.status).toBe("completed");
    expect(body.result).toEqual(CRON_TICK);
  });

  it("is a no-op without a schema", async () => {
    const body = await push(untyped, { orderId: 42 });
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ orderId: 42 });
  });
});

describe("FunctionConfig.schema — pull (worker)", () => {
  const mockFetch = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", mockFetch));
  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
  });

  async function runOneJob(data: unknown, source?: string) {
    let served = false;
    let terminal: Record<string, any> | undefined;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    mockFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/jobs")) {
        if (served) return { status: 204, ok: false };
        served = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [{
              job_id: "run-1", run_id: "run-1", function_id: "typed", attempt: 1,
              event: { id: "e1", name: "order.placed", data, timestamp: new Date().toISOString(), source },
              completed_steps: [],
            }],
          }),
        };
      }
      if (method === "PUT" && url.includes("/jobs/run-1") && !url.endsWith("/ack")) {
        terminal = JSON.parse(init?.body ?? "{}");
        resolveDone();
      }
      return { ok: true, status: 200 };
    });
    const worker = createWorker({
      serverUrl: "http://localhost",
      apiKey: "k",
      logger: false,
      functions: [
        createFunction(
          { id: "typed", triggers: [{ event: "order.placed" }], schema },
          async ({ event }) => event.data
        ),
      ],
    });
    worker.start().catch(() => {});
    await done;
    await worker.stop();
    return terminal!;
  }

  it("passes parsed data to the handler", async () => {
    const t = await runOneJob({ orderId: "o1" });
    expect(t.status).toBe("completed");
    expect(t.output).toEqual({ orderId: "o1", qty: 1 });
  });

  it("skips cron ticks on the wire", async () => {
    const t = await runOneJob(CRON_TICK, "cron");
    expect(t.status).toBe("completed");
    expect(t.output).toEqual(CRON_TICK);
  });

  it("fails the job non-retryably on a mismatch", async () => {
    const t = await runOneJob({ orderId: 42 });
    expect(t.status).toBe("failed");
    expect(t.error.code).toBe("VALIDATION_ERROR");
    expect(t.error.retryable).toBe(false);
  });
});

describe("validateEventData", () => {
  const ev = (data: unknown) => ({ id: "e", name: "order.placed", version: 1, data, timestamp: new Date() });
  const fn = (s?: z.ZodType) =>
    createFunction({ id: "f", triggers: [{ event: "order.placed" }], schema: s }, async () => null);

  it("returns the same event object without a schema", async () => {
    const e = ev({ x: 1 });
    expect(await validateEventData(fn(), e)).toBe(e);
  });

  it("applies transforms", async () => {
    const out = await validateEventData(fn(z.object({ n: z.string().transform(Number) })), ev({ n: "5" }));
    expect(out.data).toEqual({ n: 5 });
    expect(out.name).toBe("order.placed");
  });

  it("supports async refinements", async () => {
    const s = z.object({ id: z.string() }).refine(async (v) => v.id !== "taken", { message: "taken" });
    await expect(validateEventData(fn(s), ev({ id: "taken" }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
    });
  });

  it("skips cron ticks", async () => {
    const tick = { ...ev({ type: "cron", expression: "* * * * *" }), source: "cron" };
    expect(await validateEventData(fn(schema), tick)).toBe(tick);
  });

  it("rejects null data non-retryably", async () => {
    await expect(validateEventData(fn(schema), ev(null))).rejects.toMatchObject({
      name: "SchemaValidationError",
      retryable: false,
    });
  });

  it("caps the issue list at 10", async () => {
    const s = z.object({ items: z.array(z.number()) });
    const err = await validateEventData(fn(s), ev({ items: Array(50).fill("x") })).catch((e) => e);
    expect(err.validationErrors).toHaveLength(11);
    expect(err.message).toContain("…and 40 more");
  });
});

describe("FunctionConfig.schema — test harness", () => {
  it("fails a run on a mismatch and parses on a match", async () => {
    const typed = createFunction(
      { id: "typed", triggers: [{ event: "order.placed" }], schema },
      async ({ event }) => event.data
    );
    const client = createTestClient({ functions: [typed] });
    const bad = await client.emit("order.placed", { orderId: 42 });
    expect(bad.status).toBe("failed");
    const ok = await client.emit("order.placed", { orderId: "o1" });
    expect(ok.output).toEqual({ orderId: "o1", qty: 1 });
  });
});
