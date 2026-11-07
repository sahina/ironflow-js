import { describe, it, expect, vi, afterEach } from "vitest";
import type { IronflowProjection, Logger } from "@ironflow/core";
import { createProjectionRunner, runnerTimings } from "./projection-runner.js";

// The runner side of ADR 0164: the delivery position goes on every poll and
// stream, rises only after a whole batch commits, stays where it was when a
// batch fails, and an old server stops the runner before it applies anything.

const LEASE = { granted: true, lease: { token: "sdk:1", epoch: "1" }, ttl: "30s" };

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function envelope(value: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function streamOf(frames: unknown[], end: boolean, signal?: AbortSignal | null): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(envelope(f));
      if (end) c.close();
      else signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }));
}

const OPEN = { kind: "PROJECTION_EVENT_KIND_OPEN", seq: "0" };

function external(handled: string[]): IronflowProjection {
  return {
    config: {
      name: "orders", events: ["order.created"], mode: "external", batchSize: 1,
      handler: async (event: { id: string }) => { handled.push(event.id); },
    },
  } as unknown as IronflowProjection;
}

function bodyOf(opts: RequestInit): Record<string, unknown> {
  const raw = opts.body;
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw.slice(5)));
  return JSON.parse(String(raw));
}

describe("projection delivery position (ADR 0164)", () => {
  const saved = { ...runnerTimings };
  afterEach(() => {
    Object.assign(runnerTimings, saved);
    vi.unstubAllGlobals();
  });

  it("opens each stream at the position, raises it to a mark only after a commit, and keeps it after a failed batch", async () => {
    const positions: unknown[] = [];
    let acks = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("RegisterProjection")) return Response.json({});
      if (url.endsWith("AckProjectionEvents")) {
        acks++;
        return acks === 2 ? new Response("{}", { status: 503 }) : Response.json({});
      }
      if (url.endsWith("StreamProjectionEvents")) {
        positions.push(bodyOf(opts).position);
        if (positions.length === 1) {
          return streamOf([OPEN, { id: "e1", seq: "1" }, { kind: "PROJECTION_EVENT_KIND_HEARTBEAT", seq: "7" }], true);
        }
        return streamOf([OPEN, { id: "e8", seq: "8" }], false, opts.signal);
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const handled: string[] = [];
    const runner = createProjectionRunner({ projection: external(handled), baseUrl: "http://x", headers: {}, logger: logger() });
    const run = runner.startStreaming();
    await vi.waitFor(() => expect(positions.length).toBeGreaterThanOrEqual(3), { timeout: 15_000 });
    await runner.stop();
    await run.catch(() => {});
    expect(positions.slice(0, 3)).toEqual(["0", "7", "7"]);
  }, 20_000);

  it("sends the poll position and raises it to the watermark only after the batch commits", async () => {
    const positions: unknown[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("RegisterProjection")) return Response.json({});
      if (url.endsWith("AckProjectionEvents")) return polls === 2 ? new Response("{}", { status: 503 }) : Response.json({});
      if (url.endsWith("PollProjectionEvents")) {
        polls++;
        positions.push(bodyOf(opts).position);
        if (polls === 1) return Response.json({ events: [], lastEventSeq: "40", position: "0" });
        if (polls <= 3) return Response.json({ events: [{ id: "e41", seq: "41" }], lastEventSeq: "45", position: "40" });
        return Response.json({ events: [], lastEventSeq: "45", position: "45" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    runnerTimings.standbyRetryMs = 1;
    const handled: string[] = [];
    const runner = createProjectionRunner({ projection: external(handled), baseUrl: "http://x", headers: {}, logger: logger() });
    const run = runner.start();
    await vi.waitFor(() => expect(positions.length).toBeGreaterThanOrEqual(4), { timeout: 15_000 });
    await runner.stop();
    await run.catch(() => {});
    expect(positions.slice(0, 4)).toEqual(["0", "40", "40", "45"]);
  }, 20_000);

  it.each(["poll", "stream"])("stops with SERVER_TOO_OLD against an old server (%s) and applies nothing", async (transport) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("RegisterProjection")) return Response.json({});
      if (url.endsWith("PollProjectionEvents")) return Response.json({ events: [{ id: "e1", seq: "1" }], lastEventSeq: "1" });
      if (url.endsWith("StreamProjectionEvents")) return streamOf([{ id: "e1", seq: "1" }], true);
      return Response.json({});
    }));
    const handled: string[] = [];
    const runner = createProjectionRunner({ projection: external(handled), baseUrl: "http://x", headers: {}, logger: logger() });
    const run = transport === "poll" ? runner.start() : runner.startStreaming();
    await expect(run).rejects.toMatchObject({ code: "SERVER_TOO_OLD" });
    expect(handled).toEqual([]);
    await runner.stop();
  });

  it("stops with SERVER_TOO_OLD when a stream ends before an OPEN frame", async () => {
    let streams = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("StreamProjectionEvents")) {
        streams++;
        return streamOf([], true);
      }
      return Response.json({});
    }));
    const runner = createProjectionRunner({ projection: external([]), baseUrl: "http://x", headers: {}, logger: logger() });
    await expect(runner.startStreaming()).rejects.toMatchObject({ code: "SERVER_TOO_OLD" });
    expect(streams).toBe(1);
    await runner.stop();
  });

  it.each(["poll", "stream"])("stops on failed_precondition (%s) without a retry", async (transport) => {
    const refused = { code: "failed_precondition", message: "projection is managed and its stream is behind" };
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("PollProjectionEvents")) {
        reads++;
        return Response.json(refused, { status: 400 });
      }
      if (url.endsWith("StreamProjectionEvents")) {
        reads++;
        const frames = new Uint8Array([...envelope(OPEN), ...envelope({ error: refused }, 0x02)]);
        return new Response(frames);
      }
      return Response.json({});
    }));
    const runner = createProjectionRunner({ projection: external([]), baseUrl: "http://x", headers: {}, logger: logger() });
    const run = transport === "poll" ? runner.start() : runner.startStreaming();
    await expect(run).rejects.toThrow(/failed_precondition/);
    expect(reads).toBe(1);
    await runner.stop();
  }, 20_000);

  it("stops when the state load is refused, without a retry", async () => {
    const refused = { code: "failed_precondition", message: "its last rebuild did not finish" };
    let loads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("/GetProjection")) {
        loads++;
        return Response.json(refused, { status: 400 });
      }
      return Response.json({});
    }));
    const managed = {
      config: { name: "orders", events: ["order.created"], mode: "managed", handler: async () => ({}) },
    } as unknown as IronflowProjection;
    const runner = createProjectionRunner({ projection: managed, baseUrl: "http://x", headers: {}, logger: logger() });
    await expect(runner.startStreaming()).rejects.toThrow(/its last rebuild did not finish/);
    expect(loads).toBe(1);
    await runner.stop();
  }, 20_000);

  it("stops when a partition's state load is refused", async () => {
    const refused = { code: "failed_precondition", message: "its last rebuild did not finish" };
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("ProjectionLease")) return Response.json(LEASE);
      if (url.endsWith("/GetProjection")) return Response.json(refused, { status: 400 });
      if (url.endsWith("PollProjectionEvents")) {
        polls++;
        return Response.json({
          position: "0", lastEventSeq: "1",
          events: [{ id: "e1", name: "order.created", seq: "1", metadata: { __partition: "a" } }],
        });
      }
      return Response.json({});
    }));
    const managed = {
      config: { name: "orders", events: ["order.created"], mode: "managed", batchSize: 1, handler: async () => ({}) },
    } as unknown as IronflowProjection;
    const runner = createProjectionRunner({ projection: managed, baseUrl: "http://x", headers: {}, logger: logger() });
    await expect(runner.start()).rejects.toThrow(/its last rebuild did not finish/);
    expect(polls).toBe(1);
    await runner.stop();
  }, 20_000);
});
