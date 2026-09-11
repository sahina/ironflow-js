import { afterEach, describe, expect, it, vi } from "vitest";
import type { PushRequest } from "@ironflow/core";
import { createFunction } from "./function.js";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient } from "./step.js";
import { createWorker } from "./worker.js";

const timestamp = "2026-06-15T12:34:56.789Z";
const reply = {
  id: "reply-1",
  name: "order.approved",
  version: 1,
  timestamp,
  data: { approvedAt: timestamp },
  metadata: { timestamp },
};

afterEach(() => vi.unstubAllGlobals());

describe("event timestamps over JSON (#2191)", () => {
  it.each([
    ["resume", timestamp],
    ["resume", new Date(timestamp)],
    ["replay", timestamp],
    ["replay", new Date(timestamp)],
  ])("revives %s timestamps supplied as %s without changing event data", async (mode, value) => {
    const event = { ...reply, timestamp: value };
    const request: PushRequest = {
      run_id: "run-1",
      function_id: "fn",
      attempt: 2,
      event: reply,
      steps: mode === "replay"
        ? [{ id: "run-1:reply:0", name: "reply", status: "completed", output: event }]
        : [],
      resume: mode === "resume"
        ? { step_id: "run-1:reply:0", type: "wait_for_event", data: event }
        : undefined,
    };
    const step = createStepClient(new ExecutionContext(request));
    const signal = await step.waitForEvent<{ approvedAt: string }>("reply", { event: reply.name });

    expect(signal.timestamp.toISOString()).toBe(timestamp);
    expect(signal).toEqual({ ...reply, timestamp: new Date(timestamp) });
    expect(signal.data.approvedAt).toBe(timestamp);
    expect(event.timestamp).toBe(value);
  });

  it("lets a REST worker use Date methods on its trigger and awaited reply", async () => {
    let served = false;
    const updates: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/jobs") && (init?.method ?? "GET") === "GET" && !served) {
        served = true;
        return Response.json({ jobs: [{
          job_id: "run-1",
          run_id: "run-1",
          function_id: "fn",
          attempt: 2,
          event: { ...reply, id: "trigger-1", name: "order.created" },
          completed_steps: [{ step_id: "run-1:reply:0", name: "reply", output: reply }],
        }] });
      }
      if (url.includes("/jobs") && (init?.method ?? "GET") === "GET") {
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PUT" && url.endsWith("/jobs/run-1")) {
        updates.push(JSON.parse(String(init.body)));
      }
      return Response.json({});
    }));
    const fn = createFunction({ id: "fn", triggers: [{ event: "order.created" }] }, async ({ event, step }) => {
      const signal = await step.waitForEvent("reply", { event: "order.approved" });
      return { trigger: event.timestamp.toISOString(), reply: signal.timestamp.toISOString() };
    });
    const worker = createWorker({
      serverUrl: "http://localhost:9123",
      functions: [fn],
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(updates[0]).not.toHaveProperty("error");
      expect(updates[0]).toMatchObject({
        status: "completed",
        output: { trigger: timestamp, reply: timestamp },
      });
    } finally {
      await worker.stop();
      await running;
    }
  });
});
