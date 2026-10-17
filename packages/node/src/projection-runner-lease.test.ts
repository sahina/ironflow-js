// ADR 0120 lease client. The test names match the Go (#2798) and Python (#2799) runners.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IronflowProjection, Logger } from "@ironflow/core";
import {
  createProjectionRunner, runnerTimings, startProjectionRunners, StreamingUnsupportedError, type ProjectionRunner,
} from "./projection-runner.js";

const TRANSPORTS = ["poll", "stream"] as const;
type Transport = (typeof TRANSPORTS)[number];
const GRANTED = "lease granted";
const STANDBY = "lease held by another runner, standing by";
const LOST = "lease lost";
const LADDER = /stream disconnected|stream error|flush failed/;

interface Event {
  id: string;
  name: string;
  data: unknown;
  seq: number;
  metadata: Record<string, unknown>;
}

function event(id: string, seq: number, pk = ""): Event {
  return { id, name: "inc", data: { n: 1 }, seq, metadata: pk ? { __partition: pk } : {} };
}

function envelope(msg: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

const lostBody = { code: "aborted", message: "projection lease lost" };
const lostResponse = () => new Response(JSON.stringify(lostBody), { status: 409 });

/**
 * A server with the ADR 0120 rules: one holder, a fence on the epoch, and Aborted for a
 * stale epoch on Poll, Stream, Save, Ack and Renew. Two runners can share it.
 */
class LeaseFake {
  epoch = 0;
  held = false;
  ttl = "0.300s";
  noLease = false; // an older server: Acquire is Unimplemented (HTTP 404)
  pollOnly = false; // the stream is Unimplemented, so the runner polls
  streamFence = false; // the stream ends with Aborted when the epoch changes
  batches: Event[][];
  pulls: number[] = []; // epoch of each Poll and Stream (0: no lease)
  saves: [string, number, boolean][] = []; // (partition, epoch, aborted) of each Save and Ack
  registers = 0;
  acquires = 0;
  renews = 0;
  renewError: (() => Response) | null = null;
  renewHangs = false; // Renew answers only when the request is aborted
  ackError: (() => Response) | null = null;
  saveError: (() => Response) | null = null;
  trailer = ""; // the next stream ends after its batch with this error code
  fenceSave: ((pk: string) => boolean) | null = null; // true: a rebuild start fences this save
  acquireDelayMs = 0;
  acquireHangs = false; // Acquire answers only when the request is aborted
  onStreamAbort: (() => void) | null = null; // runs inside the runner's abort of the stream

  constructor(...batches: Event[][]) {
    this.batches = batches;
  }

  /** Another runner takes the lease, as when the lease expires. */
  takeOver(): void {
    this.epoch++;
    this.held = true;
  }

  /** End the other runner's lease. */
  free(): void {
    this.epoch++;
    this.held = false;
  }

  private stale(req: { lease?: { epoch: string } }): boolean {
    return req.lease !== undefined && (!this.held || Number(req.lease.epoch) !== this.epoch);
  }

  private fenced(req: { lease?: { epoch: string } }, pk: string): boolean {
    let aborted = this.stale(req);
    if (!aborted && this.fenceSave?.(pk)) {
      this.free(); // a non-SQL rebuild start bumps the epoch and frees the lease
      aborted = true;
    }
    this.saves.push([pk, Number(req.lease?.epoch ?? 0), aborted]);
    return aborted;
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const raw = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body.slice(5)) : String(init.body);
    const req = JSON.parse(raw);
    switch (method) {
      case "RegisterProjection":
        this.registers++;
        return Response.json({});
      case "GetProjection":
        return Response.json({});
      case "AcquireProjectionLease":
        this.acquires++;
        if (this.acquireDelayMs) await new Promise((r) => setTimeout(r, this.acquireDelayMs));
        if (this.acquireHangs) {
          await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
        }
        if (this.noLease) return new Response(null, { status: 404 });
        if (this.held) return Response.json({}); // granted = false: Connect JSON omits it
        this.takeOver();
        return Response.json({ granted: true, lease: { token: `sdk:${this.epoch}`, epoch: String(this.epoch) }, ttl: this.ttl });
      case "RenewProjectionLease":
        this.renews++;
        if (this.renewHangs) {
          await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
        }
        if (this.renewError) return this.renewError();
        return this.stale(req) ? lostResponse() : Response.json({ ttl: this.ttl });
      case "ReleaseProjectionLease":
        if (!this.stale(req)) this.free();
        return Response.json({});
      case "PollProjectionEvents":
        this.pulls.push(Number(req.lease?.epoch ?? 0));
        return this.stale(req) ? lostResponse() : Response.json({ events: this.batches.shift() ?? [] });
      case "StreamProjectionEvents":
        return this.stream(req, init.signal ?? undefined);
      case "SaveProjectionState":
        if (this.saveError) return this.saveError();
        return this.fenced(req, req.partitionKey) ? lostResponse() : Response.json({});
      case "AckProjectionEvents":
        if (this.ackError) return this.ackError();
        return this.fenced(req, "") ? lostResponse() : Response.json({});
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  private stream(req: { lease?: { epoch: string } }, signal?: AbortSignal): Response {
    if (this.pollOnly) return new Response(null, { status: 404 });
    this.pulls.push(Number(req.lease?.epoch ?? 0));
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        const end = () => {
          clearInterval(timer);
          c.enqueue(envelope({ error: lostBody }, 0x02));
          c.close();
        };
        signal?.addEventListener("abort", () => {
          this.onStreamAbort?.();
          clearInterval(timer);
          try { c.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ }
        }, { once: true });
        if (this.stale(req)) return end();
        // One batch per stream: the next one comes after a rewind, on the next open.
        for (const e of this.batches.shift() ?? []) c.enqueue(envelope(e));
        if (this.trailer) {
          c.enqueue(envelope({ error: { code: this.trailer, message: this.trailer } }, 0x02));
          this.trailer = "";
          return c.close();
        }
        timer = setInterval(() => { if (this.streamFence && this.stale(req)) end(); }, 5);
      },
    });
    return new Response(body);
  }
}

class Runner {
  handled: string[] = [];
  lines: string[] = [];
  runner: ProjectionRunner;
  logger: Logger;
  projection: IronflowProjection;

  constructor(
    svc: LeaseFake,
    transport: Transport,
    opts: { external?: boolean; handler?: (e: Event) => unknown; start?: boolean } = {},
  ) {
    svc.pollOnly = transport === "poll";
    const log = (msg: unknown) => { this.lines.push(String(msg)); };
    const logger: Logger = (this.logger = { debug: log, info: log, warn: log, error: log });
    const projection = (this.projection = {
      config: opts.external
        ? {
          name: "x", events: ["inc"], mode: "external", batchSize: 100, maxRetries: 3,
          handler: opts.handler ?? ((e: Event) => { this.handled.push(e.id); }),
        }
        : {
          name: "x", events: ["inc"], mode: "managed", batchSize: 100, maxRetries: 3,
          initialState: () => ({ count: 0 }),
          handler: (s: { count: number }, e: Event) => { this.handled.push(e.id); return { count: s.count + 1 }; },
        },
    } as unknown as IronflowProjection);
    this.runner = opts.start === false
      ? createProjectionRunner({ projection, baseUrl: "http://fake", headers: {}, logger })
      : startProjectionRunners({ projections: [projection], baseUrl: "http://fake", headers: {}, logger })[0] as ProjectionRunner;
  }

  logs(text: string | RegExp): number {
    return this.lines.filter((l) => (typeof text === "string" ? l.includes(text) : text.test(l))).length;
  }

  get pending(): Event[] {
    return (this.runner as unknown as { pendingEvents: Event[] }).pendingEvents;
  }
}

async function until(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("projection runner lease (ADR 0120)", () => {
  const saved = { ...runnerTimings };
  let svc: LeaseFake;

  beforeEach(() => {
    Object.assign(runnerTimings, { flushIntervalMs: 10, standbyRetryMs: 50, renewRetryMs: 20 });
  });

  afterEach(() => {
    Object.assign(runnerTimings, saved);
    vi.unstubAllGlobals();
  });

  function serve(fake: LeaseFake): LeaseFake {
    svc = fake;
    vi.stubGlobal("fetch", fake.fetch);
    return fake;
  }

  it.each(TRANSPORTS)("two_runners_only_holder_reads (%s)", async (transport) => {
    serve(new LeaseFake([event("e1", 1)]));
    const holder = new Runner(svc, transport, { external: true });
    await until("the first grant", () => holder.logs(GRANTED) === 1);
    const standby = new Runner(svc, transport, { external: true });
    await until("standby retries", () => svc.acquires >= 4);
    await until("the holder's ack", () => svc.saves.length === 1);
    await standby.runner.stop();
    await holder.runner.stop();

    expect(svc.pulls.every((e) => e === 1), `pulls = ${svc.pulls}`).toBe(true);
    expect(svc.saves[0]).toEqual(["", 1, false]);
    expect(standby.logs(STANDBY)).toBe(1);
    expect(standby.logs(GRANTED)).toBe(0);
    expect(standby.handled).toEqual([]);
    expect(holder.handled).toEqual(["e1"]);
  });

  it.each(TRANSPORTS)("standby_takes_over_after_holder_stops (%s)", async (transport) => {
    serve(new LeaseFake([event("e1", 1)]));
    const holder = new Runner(svc, transport);
    await until("the first grant", () => holder.logs(GRANTED) === 1);
    const standby = new Runner(svc, transport);
    await until("standby", () => standby.logs(STANDBY) === 1);

    await holder.runner.stop(); // Release: epoch 2, the lease is free
    svc.batches = [[event("e2", 2)]];
    await until("the takeover", () => standby.logs(GRANTED) === 1);
    await until("a save from the new holder", () => svc.saves.some(([, e]) => e === 3));
    await standby.runner.stop();
    expect(svc.pulls).toContain(3);
  });

  it.each(TRANSPORTS)("fenced_save_stops_batch_no_retry (%s)", async (transport) => {
    const batch = [event("a1", 1, "a"), event("b1", 2, "b"), event("a2", 3, "a")];
    // The server rewinds after the fence, so the new holder reads the batch again.
    serve(new LeaseFake(batch, batch));
    let fenced = false;
    svc.fenceSave = (pk) => {
      if (pk !== "b" || fenced) return false;
      fenced = true;
      return true;
    };
    const r = new Runner(svc, transport);
    await until("the batch saved under the new lease", () => svc.saves.length === 5);
    await r.runner.stop();

    expect(svc.saves).toEqual([
      ["a", 1, false], ["b", 1, true], // stop at the fenced save; no retry with epoch 1
      ["a", 3, false], ["b", 3, false], ["a", 3, false],
    ]);
    expect(r.logs(LOST)).toBe(1);
    expect(r.logs(GRANTED)).toBe(2);
    expect(r.logs(LADDER), "a lost lease must not use the reconnect ladder").toBe(0);
  });

  it.each(TRANSPORTS)("expired_lease_goes_to_standby (%s)", async (transport) => {
    // The stream does not end on its own: Renew finds the lost lease and the runner drops
    // the two pending frames.
    serve(new LeaseFake([event("e1", 1), event("e2", 2)], [event("e3", 3)]));
    runnerTimings.flushIntervalMs = 3_600_000;
    const r = new Runner(svc, transport);
    await until("the first grant", () => r.logs(GRANTED) === 1);
    if (transport === "stream") await until("the pending frames", () => r.pending.length === 2);

    svc.takeOver(); // the lease expired and another runner took it
    await until("standby", () => r.logs(LOST) === 1 && r.logs(STANDBY) === 1);
    svc.free();
    await until("a new grant", () => r.logs(GRANTED) === 2);
    const epoch = svc.epoch;
    await until("a pull with the new lease", () => svc.pulls.includes(epoch));
    if (transport === "stream") {
      expect(r.handled, "the frames of the lost lease must be dropped").toEqual([]);
      expect(svc.saves).toEqual([]);
      expect(r.pending.map((e) => e.id)).not.toContain("e1");
    }
    expect(r.logs(LADDER)).toBe(0);
    await r.runner.stop();
  });

  it("stream_aborted_drops_pending_frames", async () => {
    serve(new LeaseFake([event("e1", 1), event("e2", 2)]));
    svc.ttl = "30s"; // no Renew in this test: only the stream reports the lost lease
    svc.streamFence = true;
    runnerTimings.flushIntervalMs = 3_600_000;
    const r = new Runner(svc, "stream");
    await until("the pending frames", () => r.pending.length === 2);
    svc.takeOver();
    await until("standby", () => r.logs(LOST) === 1 && r.logs(STANDBY) === 1);
    await r.runner.stop();

    expect(svc.saves, "the pending frames must be dropped").toEqual([]);
    expect(r.handled).toEqual([]);
    expect(r.logs(LADDER), "a lost lease must not use the reconnect ladder").toBe(0);
    expect(r.logs("falling back to polling"), "a lost lease must not fall back to poll").toBe(0);
    expect(svc.pulls).toEqual([1]);
  });

  it.each(TRANSPORTS)("old_server_runs_unguarded (%s)", async (transport) => {
    serve(new LeaseFake([event("e1", 1)]));
    svc.noLease = true;
    const r = new Runner(svc, transport);
    await until("an unguarded save", () => svc.saves.length === 1);
    await r.runner.stop();

    expect(svc.pulls.every((e) => e === 0) && svc.saves[0]?.[1] === 0, "no lease on any request").toBe(true);
    expect(r.logs("running unguarded")).toBe(1);
    expect(svc.acquires).toBe(1);
  });

  it("renew_transport_error_keeps_processing", async () => {
    serve(new LeaseFake());
    svc.renewError = () => new Response(JSON.stringify({ code: "unavailable", message: "renew 503" }), { status: 503 });
    const r = new Runner(svc, "poll");
    // The first Renew comes after TTL/3 (100 ms), then a retry every 20 ms.
    await until("renew retries", () => svc.renews >= 5);
    svc.batches = [[event("e1", 1)]];
    await until("a save while Renew fails", () => svc.saves.length === 1);
    await r.runner.stop();
    expect(r.logs(LOST), "a transport error must not lose the lease").toBe(0);
    expect(r.logs("lease renew failed"), "the log thins to failures 1, 2, 4, 8 …").toBeLessThan(svc.renews);
  });

  it("hung_renew_is_bounded", async () => {
    serve(new LeaseFake());
    svc.renewHangs = true;
    const r = new Runner(svc, "poll");
    // Each Renew times out after TTL/3 (100 ms); without the bound only one Renew is sent.
    await until("renew retries", () => svc.renews >= 3);
    await r.runner.stop();
  });

  it("ack_auth_error_stops_the_runner", async () => {
    serve(new LeaseFake([event("e1", 1)]));
    svc.ackError = () => new Response(JSON.stringify({ code: "permission_denied", message: "no" }), { status: 403 });
    const r = new Runner(svc, "poll", { external: true });
    await until("the runner stops", () => r.logs("Projection runner failed") === 1);
    await r.runner.stop();
    expect(r.logs("Projection poll error"), "an auth error must not poll forever").toBe(0);
  });

  it("stop_releases_after_the_final_save", async () => {
    serve(new LeaseFake([event("e1", 1)]));
    svc.ttl = "30s";
    runnerTimings.flushIntervalMs = 3_600_000; // only stop() flushes the pending frame
    const r = new Runner(svc, "stream");
    await until("the pending frame", () => r.pending.length === 1);
    await r.runner.stop();
    expect(svc.saves, "the final save must run before Release fences it").toEqual([["__global__", 1, false]]);
    expect(svc.held).toBe(false);
  });

  it.each(TRANSPORTS)("lost_lease_stops_external_batch (%s)", async (transport) => {
    serve(new LeaseFake([1, 2, 3, 4].map((i) => event(`e${i}`, i))));
    const handled: string[] = [];
    const r = new Runner(svc, transport, {
      external: true,
      handler: async (e) => {
        handled.push(e.id);
        if (e.id === "e2") {
          svc.takeOver();
          await sleep(300); // Renew (every 100 ms) finds the lease lost meanwhile
        }
      },
    });
    await until("standby", () => r.logs(LOST) === 1);
    await r.runner.stop();
    expect(handled, "no handler may run after the lease is lost").toEqual(["e1", "e2"]);
    expect(svc.saves, "the batch must not be acked").toEqual([]);
  });

  it("stop_during_acquire_releases_the_grant", async () => {
    serve(new LeaseFake());
    svc.acquireDelayMs = 100;
    const r = new Runner(svc, "stream");
    await sleep(30); // the Acquire is in flight
    await r.runner.stop();
    expect(svc.epoch, "the late grant must be released").toBe(2);
    expect(svc.held).toBe(false);
    expect(svc.pulls).toEqual([]);
  });

  it("poll_fallback_keeps_one_lease_and_one_register", async () => {
    serve(new LeaseFake([event("e1", 1)]));
    const r = new Runner(svc, "poll");
    await until("a save", () => svc.saves.length === 1);
    await r.runner.stop();
    expect(svc.registers).toBe(1);
    expect(svc.acquires).toBe(1);
    expect(r.logs("falling back to polling")).toBe(1);
  });

  it("fenced_flush_after_stream_error_goes_to_standby", async () => {
    // The stream error is transient, but the save of the frames before it is fenced.
    serve(new LeaseFake([event("e1", 1)]));
    svc.trailer = "unavailable";
    let fenced = false;
    svc.fenceSave = () => !fenced && (fenced = true);
    const r = new Runner(svc, "stream");
    await until("a new grant", () => r.logs(LOST) === 1 && r.logs(GRANTED) === 2);
    await r.runner.stop();

    expect(svc.saves[0]?.slice(1)).toEqual([1, true]);
    expect(r.logs(LADDER), "a lost lease must not use the reconnect ladder").toBe(0);
    expect(svc.pulls.slice(0, 2), "no stream with the fenced epoch").toEqual([1, 3]);
  });

  it("unsupported_stream_with_failed_flush_falls_back_to_poll", async () => {
    serve(new LeaseFake([event("e1", 1)], [event("e2", 2)]));
    svc.trailer = "unimplemented";
    svc.saveError = () => {
      svc.saveError = null;
      return new Response("boom", { status: 500 });
    };
    const r = new Runner(svc, "stream");
    await until("a poll save", () => svc.saves.length === 1);
    await r.runner.stop();

    expect(r.logs("flush after stream error failed")).toBe(1);
    expect(r.logs("falling back to polling")).toBe(1);
    expect(svc.saves[0]?.[2]).toBe(false);
  });

  it("streaming_unsupported_releases_the_lease", async () => {
    // A direct startStreaming() caller that does not go on to poll must not keep the lease.
    serve(new LeaseFake());
    const r = new Runner(svc, "poll", { start: false });
    await expect(r.runner.startStreaming()).rejects.toThrow(StreamingUnsupportedError);
    expect(svc.held).toBe(false);
    const renews = svc.renews;
    await sleep(250); // TTL/3 is 100 ms
    expect(svc.renews, "no renew after the release").toBe(renews);
    await r.runner.stop();
  });

  it("stop_racing_a_lost_lease_drops_pending_frames", async () => {
    serve(new LeaseFake([event("e1", 1)]));
    runnerTimings.flushIntervalMs = 3_600_000;
    const r = new Runner(svc, "stream");
    await until("the pending frame", () => r.pending.length === 1);
    let stopped: Promise<void> | undefined;
    // Renew finds the lease lost and closes the stream; stop() comes before the stream loop sees it.
    svc.onStreamAbort = () => { stopped ??= r.runner.stop(); };
    svc.takeOver();
    await until("the stop", () => stopped !== undefined);
    await expect(stopped).resolves.toBeUndefined();
    expect(svc.saves, "the lost grant's frame must not be saved").toEqual([]);
    expect(r.handled).toEqual([]);
  });

  it("stop_bounds_a_hung_handler_and_releases", async () => {
    serve(new LeaseFake([event("e1", 1)]));
    runnerTimings.stopTimeoutMs = 50;
    const r = new Runner(svc, "stream", { external: true, handler: () => new Promise(() => {}) });
    await until("the grant", () => svc.held);
    await until("the handler", () => svc.pulls.length === 1);
    await new Promise((res) => setTimeout(res, 20));
    const started = Date.now();
    await r.runner.stop();
    expect(Date.now() - started, "stop() must not wait for a hung handler").toBeLessThan(1000);
    expect(svc.held, "the lease must be released after the bound").toBe(false);
    expect(r.logs("stop timed out")).toBe(1);
  });

  it("stop_bounds_a_hung_acquire", async () => {
    serve(new LeaseFake());
    svc.acquireHangs = true;
    runnerTimings.stopTimeoutMs = 50;
    const r = new Runner(svc, "stream");
    await until("the Acquire", () => svc.acquires === 1);
    const started = Date.now();
    await r.runner.stop();
    expect(Date.now() - started, "stop() must not wait for a hung Acquire").toBeLessThan(1000);
    expect(r.logs("lease acquire failed")).toBe(0);
  });
});
