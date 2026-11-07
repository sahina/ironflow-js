import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { ExecutionContext } from "./internal/context.js";
import type { PushRequest } from "@ironflow/core";
import { createStreamingWorker } from "./worker-streaming.js";
import { serve } from "./serve.js";
import { createWorker } from "./worker.js";
import { createFunction } from "./function.js";

afterEach(() => vi.unstubAllGlobals());

describe("event emitter reads (#3390)", () => {
  it.each(["apikey:k1", undefined])("exposes stored and stream emitter %s", async (emitter) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("ReadStream")
      ? { events: [{ id: "e", emittedBy: emitter, timestamp: "2026-01-01T00:00:00Z" }] }
      : { id: "e", emitted_by: emitter, timestamp: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" })));
    const client = createClient({ serverUrl: "http://localhost:9123" });
    expect(await client.getEvent("e")).toHaveProperty("emittedBy", emitter);
    expect((await client.streams.read("seat-1")).events[0]).toHaveProperty("emittedBy", emitter);
  });

  it("preserves the engine's emitter on a push/REST trigger", () => {
    const request = { run_id: "r", function_id: "f", attempt: 1, steps: [], event: {
      id: "e", name: "created", timestamp: new Date().toISOString(), data: {}, emitted_by: "apikey:k1",
    } } as PushRequest;
    expect(new ExecutionContext(request).event).toHaveProperty("emittedBy", "apikey:k1");
  });


  it.each(["apikey:k1", undefined])("preserves emitter %s through the public push handler", async (emitter) => {
    const fn = createFunction({ id: "f", triggers: [] }, async ({ event }) => ({ emitter: event.emittedBy ?? null }));
    const handler = serve({ functions: [fn], skipVerification: true, logger: false });
    const response = await handler(new Request("http://localhost:9123/handler", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: "r", function_id: "f", attempt: 1, steps: [], event: {
        id: "e", name: "created", data: {}, timestamp: new Date().toISOString(), emitted_by: emitter,
      } }),
    }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "completed", result: { emitter: emitter ?? null } });
  });

  it.each(["apikey:k1", undefined])("preserves emitter %s through REST job validation and execution", async (emitter) => {
    let served = false;
    const updates: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/jobs") && (init?.method ?? "GET") === "GET") {
        if (served) return new Response(null, { status: 204 });
        served = true;
        return Response.json({ jobs: [{ job_id: "r", run_id: "r", function_id: "f", attempt: 1,
          completed_steps: [], event: { id: "e", name: "created", data: {}, timestamp: new Date().toISOString(), emitted_by: emitter },
        }] });
      }
      if (init?.method === "PUT" && url.endsWith("/jobs/r")) updates.push(JSON.parse(String(init.body)));
      return Response.json({});
    }));
    const worker = createWorker({ functions: [createFunction({ id: "f", triggers: [] }, async ({ event }) => ({ emitter: event.emittedBy ?? null }))], logger: false });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(updates[0]).toMatchObject({ status: "completed", output: { emitter: emitter ?? null } });
    } finally {
      worker.stop();
      await running;
    }
  });

  it("preserves the engine's emitter on a streaming trigger", async () => {
    const handler = vi.fn(async ({ event }) => event.emittedBy);
    const worker = createStreamingWorker({ functions: [createFunction({ id: "f", triggers: [] }, handler)], logger: false });
    await (worker as unknown as { handleJobAssignment(job: unknown): Promise<void> }).handleJobAssignment({
      jobId: "j", runId: "r", functionId: "f", attempt: 1, executionSeq: 1n, leaseToken: "t",
      event: { id: "e", name: "created", data: {}, emittedBy: "apikey:k1" }, completedSteps: [],
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0]?.[0].event.emittedBy).toBe("apikey:k1");
    worker.stop();
  });
});
