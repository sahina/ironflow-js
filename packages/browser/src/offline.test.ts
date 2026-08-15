/**
 * End-to-end tests for the offline client: enqueue -> IndexedDB -> drain over
 * the real client `send()` path, with `fetch` mocked at the boundary.
 *
 * These are the tests that would catch a wiring mistake the unit tests cannot:
 * wrong endpoint path, wrong request body shape, a queued write that never
 * reaches the network, or a reload losing writes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueueFullError } from "@ironflow/core";
import { createClient, queueDbName, type OfflineClient } from "./offline.js";
import type { QueueStats, WriteStatus } from "./queue/types.js";

let live: OfflineClient[] = [];
let n = 0;

afterEach(async () => {
  for (const c of live) await c.close();
  live = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function okResponse(body: unknown = { eventId: "evt_1" }): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, message = "nope"): Response {
  const body = JSON.stringify({ message, code: `HTTP_${status}` });
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

async function make(
  overrides: Partial<Parameters<typeof createClient>[0]["offlineQueue"]> = {}
): Promise<OfflineClient> {
  const client = await createClient({
    serverUrl: "http://test:9123",
    logger: false,
    offlineQueue: { identity: "user-1", dbName: `offline-test-${n++}`, ...overrides },
  });
  live.push(client);
  return client;
}

/** Let the drainer's microtasks settle. */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("createClient", () => {
  it("reports the queue enabled when IndexedDB is present", async () => {
    const c = await make();
    expect(c.queue.enabled).toBe(true);
  });

  it("degrades to direct writes with no IndexedDB, instead of throwing", async () => {
    // The SSR / Node case. Throwing here would crash a server render for
    // anyone who put the option in shared config.
    vi.stubGlobal("indexedDB", undefined);
    const fetchMock = vi.fn(async () => okResponse({ eventId: "evt_direct" }));
    vi.stubGlobal("fetch", fetchMock);

    // Through the app's own logger, not console: an app that quieted the SDK
    // must not be shouted at on every SSR render.
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const c = await createClient({
      serverUrl: "http://test:9123",
      logger,
      offlineQueue: { identity: "user-1" },
    });
    live.push(c);

    expect(c.queue.enabled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("IndexedDB is unavailable"));

    // Reports honestly that nothing was queued and nothing is pending — a
    // badge must not show work for a write that already landed.
    const result = await c.emit("order.placed", { id: 1 });
    expect(result).toMatchObject({ queued: false, pending: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the real dedup key on the direct path too (#1609)", async () => {
    // With the queue disabled the field used to be "" whenever the caller
    // passed no key, while its docstring promises "the dedup key the engine
    // will see" — and the engine skips dedup entirely for an empty key. A
    // caller retrying on that key would double-write.
    vi.stubGlobal("indexedDB", undefined);
    const fetchMock = vi.fn(async () => okResponse({ eventId: "evt_direct" }));
    vi.stubGlobal("fetch", fetchMock);

    const c = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1" },
    });
    live.push(c);

    const emitted = await c.emit("order.placed", { id: 1 });
    expect(emitted.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // Not just non-empty: the key the engine actually saw.
    expect(lastBody(fetchMock).idempotency_key).toBe(emitted.idempotencyKey);

    const appended = await c.streams.append("order-1", {
      entityType: "order",
      name: "created",
      data: {},
    });
    expect(appended.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastBody(fetchMock).idempotency_key).toBe(appended.idempotencyKey);
  });

  it("treats an empty caller-supplied key as absent (#1609 review)", async () => {
    // `??` honoured "" verbatim. The engine skips dedup entirely for an empty
    // key, so the reported field named a key that does not dedup — on both the
    // queued and the direct path.
    vi.stubGlobal("indexedDB", undefined);
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const c = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1" },
    });
    live.push(c);

    const r = await c.emit("e", { id: 1 }, { idempotencyKey: "" });
    expect(r.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastBody(fetchMock).idempotency_key).toBe(r.idempotencyKey);
  });

  it("still degrades when Web Crypto is missing too (#1609 review)", async () => {
    // The no-IndexedDB path exists for SSR / Node / locked-down WebViews.
    // newUuid() THROWS without Web Crypto, so generating a key unconditionally
    // turned that documented degradation into a crash on exactly those hosts.
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("crypto", {});
    const fetchMock = vi.fn(async () => okResponse({ eventId: "evt_direct" }));
    vi.stubGlobal("fetch", fetchMock);

    const c = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1" },
    });
    live.push(c);

    const r = await c.emit("e", { id: 1 });
    expect(r).toMatchObject({ queued: false, pending: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No key was generated, and the field says so rather than inventing one.
    expect(r.idempotencyKey).toBe("");
    expect(lastBody(fetchMock).idempotency_key).toBeUndefined();
  });

  it("keeps a caller-supplied key on the direct path", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const c = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1" },
    });
    live.push(c);

    const r = await c.emit("e", { id: 1 }, { idempotencyKey: "caller-key" });
    expect(r.idempotencyKey).toBe("caller-key");
    expect(lastBody(fetchMock).idempotency_key).toBe("caller-key");
  });

  it("keeps its documented caps when the app omits them", async () => {
    // Regression: createClient forwards every optional cap unconditionally, so
    // omitting them passed `undefined` into an object spread that overwrote the
    // defaults. All four limits were silently disabled on the normal path — the
    // queue never filled, nothing ever expired, and the dead-letter store grew
    // forever. Every existing test passed because they all set the caps.
    const c = await make();
    const opts = (
      c as unknown as { offlineQueue: { opts: Record<string, unknown> } }
    ).offlineQueue.opts;

    expect(opts.maxItems).toBe(500);
    expect(opts.maxBytes).toBe(5 * 1024 * 1024);
    expect(opts.maxRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(opts.maxDeadLettered).toBe(100);
  });

  it("scopes the database to serverUrl and environment", () => {
    // A staging queue must never flush into prod.
    expect(queueDbName("http://a", "default")).not.toBe(
      queueDbName("http://b", "default")
    );
    expect(queueDbName("http://a", "staging")).not.toBe(
      queueDbName("http://a", "prod")
    );
  });
});

describe("emit through the queue", () => {
  it("resolves before the network is touched at all", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const c = await make();
    const result = await c.emit("order.placed", { id: 1 });

    // The point of write-through: the caller has an answer and a durable
    // record before any request is attempted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ queued: true, pending: true });
    expect(result.localId).toMatch(/^[0-9a-f-]{36}$/);

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts to the Emit endpoint with the Connect body shape", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      okResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = await make();
    await c.emit("order.placed", { id: 1 }, { namespace: "shop" });
    await settle();

    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "http://test:9123/ironflow.v1.PubSubService/Emit"
    );
    expect(lastBody(fetchMock)).toMatchObject({
      event: "order.placed",
      data: { id: 1 },
      namespace: "shop",
    });
  });

  it("sends the same idempotency key it returned at enqueue", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const c = await make();
    const { idempotencyKey } = await c.emit("order.placed", { id: 1 });
    await settle();

    expect(lastBody(fetchMock).idempotency_key).toBe(idempotencyKey);
  });

  it("preserves order across a burst", async () => {
    const seen: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).data.n);
        return okResponse();
      })
    );

    const c = await make();
    await c.emit("e", { n: 1 });
    await c.emit("e", { n: 2 });
    await c.emit("e", { n: 3 });
    await settle();

    expect(seen).toEqual([1, 2, 3]);
  });

  it("reports the write landed through queue.watch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ eventId: "evt_9" })));

    const c = await make();
    const seen: WriteStatus[] = [];
    const { localId } = await c.emit("order.placed", { id: 1 });
    c.queue.watch(localId, (s) => seen.push(s));
    await settle();

    expect(seen.at(-1)).toMatchObject({ status: "sent", eventId: "evt_9" });
  });

  it("moves a 4xx to the dead-letter store and keeps draining", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        return body.data.n === 1 ? errorResponse(400, "bad event") : okResponse();
      })
    );

    const c = await make();
    await c.emit("e", { n: 1 });
    await c.emit("e", { n: 2 });
    await settle();

    const dead = await c.queue.deadLetter();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ reason: "rejected", message: "bad event" });
    expect(c.queue.stats().pending).toBe(0);
  });

  it("retries a 429 rather than dead-lettering it", async () => {
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (first) {
          first = false;
          return errorResponse(429, "slow down");
        }
        return okResponse();
      })
    );

    const c = await make();
    await c.emit("e", { n: 1 });
    await settle();

    expect(await c.queue.deadLetter()).toEqual([]);
    await c.queue.flush();
    await settle();
    expect(c.queue.stats().pending).toBe(0);
  });

  it("throws QueueFullError at the cap rather than dropping the oldest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(503)));

    const c = await make({ maxItems: 2 });
    await c.emit("e", { n: 1 });
    await c.emit("e", { n: 2 });
    await expect(c.emit("e", { n: 3 })).rejects.toBeInstanceOf(QueueFullError);
    await settle();

    expect(c.queue.stats().pending).toBe(2);
  });
});

describe("streams.append through the queue", () => {
  it("posts to the AppendEvent endpoint with the expected body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      okResponse({ entityVersion: 4, eventId: "e1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = await make();
    await c.streams.append("order-1", {
      entityType: "order",
      name: "created",
      data: { total: 10 },
    });
    await settle();

    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "http://test:9123/ironflow.v1.EntityStreamService/AppendEvent"
    );
    expect(lastBody(fetchMock)).toMatchObject({
      entity_id: "order-1",
      entity_type: "order",
      event_name: "created",
      expected_version: -1,
    });
  });

  it("refuses expectedVersion, because a queued optimistic append always conflicts", async () => {
    const c = await make();

    await expect(
      c.streams.append(
        "order-1",
        { entityType: "order", name: "created", data: {} },
        { expectedVersion: 3 }
      )
    ).rejects.toThrow(/expectedVersion/);

    expect(c.queue.stats().pending).toBe(0);
  });

  it("allows the append-anyway sentinel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ entityVersion: 1 })));
    const c = await make();

    await expect(
      c.streams.append(
        "order-1",
        { entityType: "order", name: "created", data: {} },
        { expectedVersion: -1 }
      )
    ).resolves.toMatchObject({ queued: true });
  });
});

describe("durability", () => {
  it("survives a client restart with the queue intact", async () => {
    // The whole feature in one test: writes made while failing are still there
    // after the client is torn down and rebuilt against the same database.
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(503)));
    const dbName = `durability-${n++}`;

    const first = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1", dbName },
    });
    await first.emit("e", { n: 1 });
    await first.emit("e", { n: 2 });
    await settle();
    expect(first.queue.stats().pending).toBe(2);
    await first.close();

    // "Reload": new client, same database, network now healthy.
    const seen: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).data.n);
        return okResponse();
      })
    );

    const second = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1", dbName },
    });
    live.push(second);
    await settle();

    expect(seen).toEqual([1, 2]);
    expect(second.queue.stats().pending).toBe(0);
  });

  it("does not flush one user's queue as the next user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(503)));
    const dbName = `identity-${n++}`;

    const alice = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "alice", dbName },
    });
    await alice.emit("e", { owner: "alice" });
    await settle();
    await alice.close();

    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const bob = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "bob", dbName },
    });
    live.push(bob);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    const dead = await bob.queue.deadLetter();
    expect(dead[0]).toMatchObject({ reason: "identity-mismatch" });
  });
});

describe("a stored body that cannot be parsed (#1609)", () => {
  /** Corrupt the head record's body behind the client's back. */
  async function corruptHead(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onsuccess = () => {
        const tx = r.result.transaction("outbox", "readwrite");
        const cursorReq = tx.objectStore("outbox").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) cursor.update({ ...cursor.value, body: "{not json" });
        };
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
  }

  it("dead-letters it instead of stalling every write behind it", async () => {
    // The parse used to sit outside the try as an argument expression, so a
    // SyntaxError escaped as a non-Ironflow throw — which classifies as
    // "retry". The queue is strict FIFO, so that write blocked everything
    // behind it until 7-day retention expired.
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(503)));
    const dbName = `corrupt-body-${n++}`;
    const c = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      offlineQueue: { identity: "user-1", dbName },
    });
    live.push(c);

    await c.emit("e", { n: 1 });
    await c.emit("e", { n: 2 });
    await settle();
    await corruptHead(dbName);

    const seen: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).data.n);
        return okResponse();
      })
    );
    await c.queue.flush();
    await settle();

    // The write behind it still lands; the unreadable one is quarantined.
    expect(seen).toEqual([2]);
    const dead = await c.queue.deadLetter();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ reason: "rejected" });
    expect(c.queue.stats().pending).toBe(0);
  });
});

describe("queue observability", () => {
  it("emits a stats snapshot on subscribe and as writes drain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    const c = await make();
    const seen: QueueStats[] = [];
    c.queue.subscribe((s) => seen.push(s));

    await c.emit("e", { n: 1 });
    await settle();

    expect(seen[0]).toMatchObject({ pending: 0, state: "idle" });
    expect(seen.some((s) => s.pending === 1)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ pending: 0, state: "idle" });
  });

  it("lets a dead-lettered write be discarded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(400)));

    const c = await make();
    const { localId } = await c.emit("e", { n: 1 });
    await settle();

    await expect(c.queue.discard(localId)).resolves.toBe(true);
    await expect(c.queue.deadLetter()).resolves.toEqual([]);
  });

  it("lets a dead-lettered write be retried once the server recovers", async () => {
    let bad = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (bad ? errorResponse(400) : okResponse()))
    );

    const c = await make();
    const { localId } = await c.emit("e", { n: 1 });
    await settle();
    expect(await c.queue.deadLetter()).toHaveLength(1);

    bad = false;
    await expect(c.queue.retry(localId)).resolves.toBe(true);
    await settle();

    expect(c.queue.stats()).toMatchObject({ pending: 0, deadLettered: 0 });
  });
});
