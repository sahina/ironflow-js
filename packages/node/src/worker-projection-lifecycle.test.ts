import { describe, expect, it, vi } from "vitest";
import type { IronflowProjection } from "@ironflow/core";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";
import { assertDefined } from "./internal/assert-defined.js";
import { withPositionEcho } from "../tests/projection-position-fake.js";

const LEASE = { granted: true, lease: { token: "sdk:1", epoch: "1" }, ttl: "30s" };

// Engine side of the streaming worker's job stream; drop() ends it like a lost connection.
const jobStreams = vi.hoisted(() => [] as { drop: () => void }[]);

vi.mock("@connectrpc/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@connectrpc/connect")>()),
  createClient: () => ({
    connect: (messages: AsyncIterable<unknown>, opts?: { signal?: AbortSignal }) => {
      let drop = () => {};
      const ended = new Promise<void>((_, reject) => {
        drop = () => reject(new Error("dropped"));
        opts?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
      });
      jobStreams.push({ drop });
      void (async () => { for await (const _ of messages) { /* drain */ } })();
      return (async function* () { await ended; })();
    },
  }),
}));

const projection: IronflowProjection = {
  config: {
    name: "counts", events: ["created"], mode: "managed", batchSize: 1,
    initialState: () => ({ count: 0 }),
    handler: (state: unknown) => {
      expect(state).toEqual({ count: 0 });
      return { count: 1 };
    },
  },
};

function envelope(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

describe("worker projection reconnect (#2770)", () => {
  it.each([false, true])("finishes the old save before replacing runners, stopped=%s", async (stopDuringSave) => {
    let finishJobs: ((response: Response) => void) | undefined;
    let finishSave: (() => void) | undefined;
    let oldIntakeStopped = false;
    let state = { count: 0 };
    const loadedStates: { count: number }[] = [];
    let streamCount = 0;
    let workerRegistrations = 0;
    const fetchMock = vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith("/register")) workerRegistrations++;
      if (url.endsWith("RegisterFunction") || url.endsWith("RegisterProjection") || url.endsWith("/register") || url.endsWith("/heartbeat")) {
        return new Response("{}");
      }
      if (url.includes("/jobs?")) {
        return new Promise<Response>((resolve, reject) => {
          finishJobs = resolve;
          assertDefined(opts.signal).addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE); // Acquire grants; Renew and Release succeed
      if (url.endsWith("GetProjection")) {
        loadedStates.push(state);
        return Response.json({ state });
      }
      if (url.endsWith("StreamProjectionEvents")) {
        const first = streamCount++ === 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) controller.enqueue(envelope({ id: "evt-1", name: "created", data: {}, seq: 1 }));
            assertDefined(opts.signal).addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
              if (first) oldIntakeStopped = true;
            }, { once: true });
          },
        });
        return new Response(body);
      }
      if (url.endsWith("SaveProjectionState")) {
        expect(opts.signal).toBeUndefined();
        await new Promise<void>((resolve) => { finishSave = resolve; });
        state = { count: 1 };
        return new Response("{}");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", withPositionEcho(fetchMock));
    const worker = createWorker({ serverUrl: "http://localhost:9123", functions: [{ config: { id: "fn", triggers: [] }, handler: async () => ({}) }], projections: [projection], reconnectDelay: 5, logger: false });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      assertDefined(finishJobs)(new Response(null, { status: 404 }));
      await vi.waitFor(() => expect(oldIntakeStopped).toBe(true));
      // The hung save holds back only the replacement runner, not the worker reconnect.
      await vi.waitFor(() => expect(workerRegistrations).toBe(2));
      expect(loadedStates).toEqual([{ count: 0 }]);
      let workerStopped = false;
      void running.then(() => { workerStopped = true; });
      if (stopDuringSave) {
        worker.stop();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(workerStopped).toBe(false);
      }
      assertDefined(finishSave)();
      if (stopDuringSave) {
        await running;
        expect(loadedStates).toEqual([{ count: 0 }]);
      } else {
        await vi.waitFor(() => expect(loadedStates).toHaveLength(2));
        expect(loadedStates).toEqual([{ count: 0 }, { count: 1 }]);
      }
    } finally {
      worker.stop();
      finishSave?.();
      await running;
      vi.unstubAllGlobals();
    }
  });
});

describe("worker drain with projections (#2770)", () => {
  it.each([createWorker, createStreamingWorker])("resolves projection-only drain() only after the pending save finishes", async (factory) => {
    let finishSave: (() => void) | undefined;
    vi.stubGlobal("fetch", withPositionEcho(vi.fn(async (url: string, opts: RequestInit) => {
      if (url.includes("/jobs?")) {
        return new Promise<Response>((_, reject) => {
          assertDefined(opts.signal).addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE); // Acquire grants; Renew and Release succeed
      if (url.endsWith("GetProjection")) return Response.json({ state: { count: 0 } });
      if (url.endsWith("StreamProjectionEvents")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(envelope({ id: "evt-1", name: "created", data: {}, seq: 1 }));
            assertDefined(opts.signal).addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        }));
      }
      if (url.endsWith("SaveProjectionState")) await new Promise<void>((resolve) => { finishSave = resolve; });
      return new Response("{}");
    })));
    const worker = factory({ serverUrl: "http://localhost:9123", functions: [], projections: [projection], reconnectDelay: 5, logger: false });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      let drained = false;
      const draining = worker.drain().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);

      assertDefined(finishSave)();
      await draining;
    } finally {
      worker.stop();
      finishSave?.();
      await running;
      vi.unstubAllGlobals();
    }
  });
});

describe("streaming worker projection reconnect (#2770)", () => {
  it("reopens the job stream while an old projection save is pending", async () => {
    let finishSave: (() => void) | undefined;
    let state = { count: 0 };
    const loadedStates: { count: number }[] = [];
    let streamCount = 0;
    vi.stubGlobal("fetch", withPositionEcho(vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE); // Acquire grants; Renew and Release succeed
      if (url.endsWith("GetProjection")) {
        loadedStates.push(state);
        return Response.json({ state });
      }
      if (url.endsWith("StreamProjectionEvents")) {
        const first = streamCount++ === 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) controller.enqueue(envelope({ id: "evt-1", name: "created", data: {}, seq: 1 }));
            assertDefined(opts.signal).addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(body);
      }
      if (url.endsWith("SaveProjectionState")) {
        await new Promise<void>((resolve) => { finishSave = resolve; });
        state = { count: 1 };
      }
      return new Response("{}");
    })));
    jobStreams.length = 0;
    const worker = createStreamingWorker({
      serverUrl: "http://localhost:9123", functions: [{ config: { id: "fn", triggers: [] }, handler: async () => ({}) }], projections: [projection], reconnectDelay: 5, logger: false,
    });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      assertDefined(jobStreams[0]).drop();
      await vi.waitFor(() => expect(jobStreams).toHaveLength(2));
      expect(loadedStates).toEqual([{ count: 0 }]);

      assertDefined(finishSave)();
      await vi.waitFor(() => expect(loadedStates).toEqual([{ count: 0 }, { count: 1 }]));
      expect(streamCount).toBe(2);
    } finally {
      worker.stop();
      finishSave?.();
      await running;
      vi.unstubAllGlobals();
    }
  });
});

describe("projection-only workers (#3390)", () => {
  it.each([createWorker, createStreamingWorker])("runs projections without function registration, polling, job streams or job heartbeats", async (factory) => {
    const urls: string[] = [];
    jobStreams.length = 0;
    vi.stubGlobal("fetch", withPositionEcho(vi.fn(async (url: string, opts: RequestInit) => {
      urls.push(url);
      if (url.includes("/workers/")) return Response.json({ error: "function_ids is required" }, { status: 400 });
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("GetProjection")) return Response.json({ state: { count: 0 } });
      if (url.endsWith("StreamProjectionEvents")) return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(envelope({ id: "evt-1", name: "created", data: {}, seq: 1 }));
          opts.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      }));
      return Response.json({});
    })));
    const worker = factory({ serverUrl: "http://localhost:9123", functions: [], projections: [projection], heartbeatInterval: 5, reconnectDelay: 5, logger: false });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(urls.some(url => url.endsWith("SaveProjectionState"))).toBe(true));
      expect(urls.some(url => url.includes("/workers/") || url.endsWith("RegisterFunction"))).toBe(false);
      expect(jobStreams).toHaveLength(0);
      await worker.drain();
      await running;
    } finally {
      worker.stop();
      await running;
      vi.unstubAllGlobals();
    }
  });
});
