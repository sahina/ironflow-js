import { describe, it, expect, vi, afterEach } from "vitest";
import { IronflowError, QueueFullError } from "@ironflow/core";
import { OfflineQueue, classifyFailure, type SendOutcome } from "./queue.js";
import { RECORD_VERSION } from "./types.js";
import type { QueuedWrite, QueueStats, WriteStatus } from "./types.js";

let live: OfflineQueue[] = [];
let dbSeq = 0;

afterEach(async () => {
  for (const q of live) await q.stop();
  live = [];
  vi.restoreAllMocks();
});

/** HTTP error shaped exactly like the ones the client's send() produces. */
function httpError(status: number, message = `Request failed: ${status}`) {
  return new IronflowError(message, {
    code: `HTTP_${status}`,
    retryable: status >= 500 || status === 429,
  });
}

interface Harness {
  queue: OfflineQueue;
  sent: QueuedWrite[];
  send: ReturnType<typeof vi.fn>;
  /** Pending backoff callbacks; call runTimers() to fire them. */
  runTimers: () => Promise<void>;
  clock: { now: number };
  lost: Array<{ write: QueuedWrite; reason: string; message: string }>;
}

async function harness(
  opts: {
    send?: (w: QueuedWrite) => Promise<SendOutcome>;
    identity?: string;
    maxItems?: number;
    maxBytes?: number;
    maxRetentionMs?: number;
    maxDeadLettered?: number;
    onAuthRequired?: () => Promise<{ identity?: string } | void>;
    autoStart?: boolean;
  } = {}
): Promise<Harness> {
  const sent: QueuedWrite[] = [];
  const lost: Harness["lost"] = [];
  const clock = { now: 1_700_000_000_000 };
  let timers: Array<() => void> = [];

  const send = vi.fn(async (w: QueuedWrite) => {
    const result = opts.send ? await opts.send(w) : {};
    sent.push(w);
    return result;
  });

  const queue = new OfflineQueue({
    dbName: `queue-test-${dbSeq++}`,
    identity: opts.identity ?? "user-1",
    send: (_path, w) => send(w),
    resolvePath: () => "/ironflow.v1.PubSubService/Emit",
    currentDestination: () => ({
      serverUrl: "http://test:9123",
      environment: "default",
    }),
    maxItems: opts.maxItems,
    maxBytes: opts.maxBytes,
    maxRetentionMs: opts.maxRetentionMs,
    maxDeadLettered: opts.maxDeadLettered,
    onAuthRequired: opts.onAuthRequired,
    onWriteLost: (write, reason, message) => lost.push({ write, reason, message }),
    now: () => clock.now,
    schedule: (fn) => {
      timers.push(fn);
    },
  });
  live.push(queue);

  if (opts.autoStart !== false) await queue.start();

  return {
    queue,
    sent,
    send,
    lost,
    clock,
    runTimers: async () => {
      const due = timers;
      timers = [];
      for (const fn of due) fn();
      // Let the drain microtasks settle.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function emit(body: unknown = { event: "order.placed" }) {
  return { kind: "emit" as const, body };
}

/** Wait for the drainer to go quiet. */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("classifyFailure", () => {
  it("treats a non-Ironflow throw as a retryable network fault", () => {
    expect(classifyFailure(new TypeError("Failed to fetch"))).toBe("retry");
  });

  it("routes 401 to re-authentication", () => {
    expect(classifyFailure(httpError(401))).toBe("auth");
  });

  it("routes 403 to poison, NOT to re-authentication", () => {
    // 403 is insufficient permissions in this codebase; refreshing a token
    // never fixes it, so pausing on it would wait forever.
    expect(classifyFailure(httpError(403))).toBe("poison");
  });

  it("retries 5xx and 429, poisons other 4xx", () => {
    expect(classifyFailure(httpError(503))).toBe("retry");
    expect(classifyFailure(httpError(429))).toBe("retry");
    expect(classifyFailure(httpError(400))).toBe("poison");
    expect(classifyFailure(httpError(422))).toBe("poison");
  });
});

describe("OfflineQueue", () => {
  describe("enqueue", () => {
    it("persists the write and returns handles", async () => {
      const h = await harness({ send: async () => ({}) });
      const { localId, idempotencyKey } = await h.queue.enqueue(emit());

      expect(localId).toMatch(/^[0-9a-f-]{36}$/);
      expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("honours a caller-supplied idempotency key", async () => {
      const h = await harness();
      const { idempotencyKey } = await h.queue.enqueue({
        ...emit(),
        idempotencyKey: "caller-key",
      });
      expect(idempotencyKey).toBe("caller-key");
    });

    it("generates the key at enqueue so a retry reuses it", async () => {
      let attempt = 0;
      const keys: string[] = [];
      const h = await harness({
        send: async (w) => {
          keys.push(w.idempotencyKey);
          if (attempt++ === 0) throw httpError(503);
          return {};
        },
      });

      await h.queue.enqueue(emit());
      await settle();
      await h.runTimers();
      await settle();

      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("rejects at the item cap instead of dropping the oldest", async () => {
      // Never drains, so the queue fills.
      const h = await harness({
        send: async () => {
          throw httpError(503);
        },
        maxItems: 2,
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await expect(h.queue.enqueue(emit({ n: 3 }))).rejects.toBeInstanceOf(
        QueueFullError
      );

      // The oldest write is still there — nothing was evicted.
      await settle();
      expect(h.queue.stats().pending).toBe(2);
    });

    it("rejects at the byte cap", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(503);
        },
        maxBytes: 50,
      });

      await expect(
        h.queue.enqueue(emit({ padding: "x".repeat(200) }))
      ).rejects.toBeInstanceOf(QueueFullError);
      expect(h.queue.stats().pending).toBe(0);
    });

    it("refuses a body that cannot be serialised, before storing anything", async () => {
      const h = await harness();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      await expect(h.queue.enqueue(emit(cyclic))).rejects.toMatchObject({
        code: "QUEUE_UNSERIALIZABLE",
        retryable: false,
      });
      expect(h.queue.stats().pending).toBe(0);
    });

    it("refuses a BigInt body rather than reporting it saved", async () => {
      const h = await harness();
      await expect(
        h.queue.enqueue(emit({ big: BigInt(1) }))
      ).rejects.toMatchObject({ code: "QUEUE_UNSERIALIZABLE" });
      expect(h.queue.stats().pending).toBe(0);
    });
  });

  describe("draining", () => {
    it("sends writes in strict FIFO order", async () => {
      const h = await harness();
      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await h.queue.enqueue(emit({ n: 3 }));
      await settle();

      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([1, 2, 3]);
      expect(h.queue.stats()).toMatchObject({ pending: 0, state: "idle" });
    });

    it("sends one write at a time", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const h = await harness({
        send: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          concurrent -= 1;
          return {};
        },
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await settle();

      expect(maxConcurrent).toBe(1);
    });

    it("keeps a retryable failure at the head and does not skip past it", async () => {
      let fail = true;
      const h = await harness({
        send: async () => {
          if (fail) throw httpError(503);
          return {};
        },
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await settle();

      expect(h.sent).toHaveLength(0);
      expect(h.queue.stats()).toMatchObject({ pending: 2, state: "paused" });

      fail = false;
      await h.runTimers();
      await settle();

      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([1, 2]);
    });

    it("retries a 429 rather than dead-lettering it", async () => {
      // The burst a drain creates is the likeliest way to earn a 429.
      let fail = true;
      const h = await harness({
        send: async () => {
          if (fail) throw httpError(429);
          return {};
        },
      });

      await h.queue.enqueue(emit());
      await settle();
      expect(h.lost).toHaveLength(0);

      fail = false;
      await h.runTimers();
      await settle();
      expect(h.sent).toHaveLength(1);
    });

    it("dead-letters a 4xx and keeps going, so one bad write cannot deadlock the queue", async () => {
      const h = await harness({
        send: async (w) => {
          if (JSON.parse(w.body).n === 1) throw httpError(400, "bad event");
          return {};
        },
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await h.queue.enqueue(emit({ n: 3 }));
      await settle();

      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([2, 3]);
      expect(h.lost).toHaveLength(1);
      expect(h.lost[0]).toMatchObject({ reason: "rejected", message: "bad event" });
      expect(h.queue.stats()).toMatchObject({ pending: 0, deadLettered: 1 });
    });

    it("dead-letters a 403 — a permission failure is permanent", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(403, "insufficient permissions");
        },
      });

      await h.queue.enqueue(emit());
      await settle();

      expect(h.lost[0]).toMatchObject({ reason: "rejected" });
      expect(h.queue.stats().state).not.toBe("paused");
    });

    it("reports eventId back to a per-item watcher", async () => {
      const h = await harness({ send: async () => ({ eventId: "evt_1" }) });
      const seen: WriteStatus[] = [];

      const { localId } = await h.queue.enqueue(emit());
      h.queue.watch(localId, (s) => seen.push(s));
      await settle();

      expect(seen[0]).toEqual({ status: "pending" });
      expect(seen.at(-1)).toEqual({ status: "sent", eventId: "evt_1" });
    });
  });

  describe("authentication", () => {
    it("pauses on 401 instead of poisoning the queue", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(401);
        },
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await settle();

      expect(h.lost).toHaveLength(0);
      expect(h.queue.stats()).toMatchObject({ pending: 2, state: "paused" });
    });

    it("resumes after onAuthRequired resolves", async () => {
      let authed = false;
      const onAuthRequired = vi.fn(async () => {
        authed = true;
      });
      const h = await harness({
        send: async () => {
          if (!authed) throw httpError(401);
          return {};
        },
        onAuthRequired,
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await settle();

      expect(onAuthRequired).toHaveBeenCalledTimes(1);
      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([1, 2]);
    });

    it("backs off rather than dead-lettering when no onAuthRequired is configured", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(401);
        },
      });

      await h.queue.enqueue(emit());
      await settle();

      expect(h.lost).toHaveLength(0);
      expect(h.queue.stats().pending).toBe(1);
    });

    it("does not wedge the drainer when onAuthRequired never settles", async () => {
      let authed = false;
      const h = await harness({
        send: async () => {
          if (!authed) throw httpError(401);
          return {};
        },
        // A login modal the user dismissed without ever resolving its promise.
        // Awaited unbounded, this parks inside drain() while `draining` is
        // true, and every later drain() and flush() then short-circuits on the
        // flag — delivery stops for the life of the page.
        onAuthRequired: () => new Promise<void>(() => {}),
      });

      await h.queue.enqueue(emit({ n: 1 }));
      await settle();
      expect(h.sent).toHaveLength(0);

      // The auth timeout fires and the drain loop unwinds.
      await h.runTimers();
      await settle();

      authed = true;
      await h.queue.flush();
      await settle();

      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([1]);
      expect(h.lost).toHaveLength(0);
    });

    it("backs off when onAuthRequired itself fails", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(401);
        },
        onAuthRequired: async () => {
          throw new Error("user cancelled login");
        },
      });

      await h.queue.enqueue(emit());
      await settle();

      expect(h.lost).toHaveLength(0);
      expect(h.queue.stats().pending).toBe(1);
    });
  });

  describe("retention", () => {
    it("dead-letters a write older than maxRetentionMs instead of delivering it", async () => {
      const h = await harness({ maxRetentionMs: 1000 });

      await h.queue.enqueue(emit({ n: 1 }));
      await settle();
      expect(h.sent).toHaveLength(1);

      // Second write ages out before it can be sent.
      h.send.mockImplementationOnce(async () => {
        throw httpError(503);
      });
      await h.queue.enqueue(emit({ n: 2 }));
      await settle();

      h.clock.now += 5000;
      await h.runTimers();
      await settle();

      expect(h.lost).toHaveLength(1);
      expect(h.lost[0]).toMatchObject({ reason: "expired" });
      expect(h.sent).toHaveLength(1);
    });

    it("delivers a write that is still within the retention window", async () => {
      const h = await harness({ maxRetentionMs: 10_000 });
      await h.queue.enqueue(emit());
      h.clock.now += 5_000;
      await settle();

      expect(h.sent).toHaveLength(1);
      expect(h.lost).toHaveLength(0);
    });
  });

  describe("identity", () => {
    it("quarantines writes queued under a different identity", async () => {
      const first = await harness({ identity: "user-1" });
      const dbName = (first.queue as unknown as { opts: { dbName: string } }).opts
        .dbName;
      first.send.mockImplementation(async () => {
        throw httpError(503);
      });
      await first.queue.enqueue(emit({ owner: "user-1" }));
      await settle();
      await first.queue.stop();

      // A different user signs in on the same machine.
      const sent: QueuedWrite[] = [];
      const lost: Array<{ reason: string }> = [];
      const second = new OfflineQueue({
        dbName,
        identity: "user-2",
        send: async (_path, w) => {
          sent.push(w);
          return {};
        },
        resolvePath: () => "/ironflow.v1.PubSubService/Emit",
        currentDestination: () => ({
          serverUrl: "http://test:9123",
          environment: "default",
        }),
        onWriteLost: (_w, reason) => lost.push({ reason }),
        schedule: () => {},
      });
      live.push(second);
      await second.start();
      await settle();

      expect(sent).toHaveLength(0);
      expect(lost[0]).toMatchObject({ reason: "identity-mismatch" });

      // Quarantined, never deleted — still inspectable.
      const dead = await second.deadLetter();
      expect(dead).toHaveLength(1);
      expect(JSON.parse(dead[0]!.write.body).owner).toBe("user-1");
    });
  });

  describe("dead letter surface", () => {
    async function withOneDeadLetter() {
      const h = await harness({
        send: async (w) => {
          if (JSON.parse(w.body).bad) throw httpError(400, "nope");
          return {};
        },
      });
      const { localId } = await h.queue.enqueue(emit({ bad: true }));
      await settle();
      return { h, localId };
    }

    it("lists dead-lettered writes", async () => {
      const { h } = await withOneDeadLetter();
      const dead = await h.queue.deadLetter();

      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ reason: "rejected", message: "nope" });
    });

    it("discards one and reports whether it existed", async () => {
      const { h, localId } = await withOneDeadLetter();

      await expect(h.queue.discard(localId)).resolves.toBe(true);
      await expect(h.queue.deadLetter()).resolves.toEqual([]);
      await expect(h.queue.discard(localId)).resolves.toBe(false);
      expect(h.queue.stats().deadLettered).toBe(0);
    });

    it("retries one, preserving its idempotency key", async () => {
      const { h, localId } = await withOneDeadLetter();
      const original = (await h.queue.deadLetter())[0]!.write;

      h.send.mockImplementation(async (w: QueuedWrite) => {
        h.sent.push(w);
        return {};
      });

      await expect(h.queue.retry(localId)).resolves.toBe(true);
      await settle();

      expect(h.sent.at(-1)?.idempotencyKey).toBe(original.idempotencyKey);
      expect(h.queue.stats().deadLettered).toBe(0);
    });

    it("returns false when retrying something that is not dead-lettered", async () => {
      const h = await harness();
      await expect(h.queue.retry("nope")).resolves.toBe(false);
    });

    it("caps the dead-letter store, dropping oldest", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(400, "always bad");
        },
        maxDeadLettered: 2,
      });

      for (let i = 0; i < 4; i++) {
        await h.queue.enqueue(emit({ n: i }));
        h.clock.now += 1;
        await settle();
      }

      const dead = await h.queue.deadLetter();
      expect(dead).toHaveLength(2);
      expect(dead.map((d) => JSON.parse(d.write.body).n)).toEqual([2, 3]);
    });
  });

  describe("stats", () => {
    it("pushes a snapshot immediately on subscribe", async () => {
      const h = await harness();
      const seen: QueueStats[] = [];
      h.queue.subscribe((s) => seen.push(s));

      expect(seen[0]).toMatchObject({ pending: 0, state: "idle" });
    });

    it("reports total so a UI can show progress through a drain", async () => {
      const h = await harness({
        send: async () => {
          throw httpError(503);
        },
      });
      await h.queue.enqueue(emit({ n: 1 }));
      await h.queue.enqueue(emit({ n: 2 }));
      await h.queue.enqueue(emit({ n: 3 }));
      await settle();

      const seen: QueueStats[] = [];
      h.queue.subscribe((s) => seen.push(s));
      expect(seen[0]!.total).toBe(3);
    });

    it("stops notifying after unsubscribe", async () => {
      const h = await harness();
      const seen: QueueStats[] = [];
      const off = h.queue.subscribe((s) => seen.push(s));
      const initial = seen.length;

      off();
      await h.queue.enqueue(emit());
      await settle();

      expect(seen).toHaveLength(initial);
    });

    it("clears pending back to zero once the queue drains", async () => {
      const h = await harness();
      await h.queue.enqueue(emit());
      await settle();

      expect(h.queue.stats()).toMatchObject({
        pending: 0,
        inFlight: 0,
        state: "idle",
      });
    });
  });

  describe("drain scheduling", () => {
    it("does not strand a write enqueued while a drain session is winding down", async () => {
      // Regression: enqueue() calls drain(), but drain() used to drop the call
      // as a duplicate whenever one was already running. A write landing in the
      // window between the drainer reading an empty head and returning idle was
      // therefore never sent — the idle path arms no retry timer, so nothing
      // came back for it until the next enqueue, an explicit flush, or a reload.
      const h = await harness();
      // Let start()'s own drain finish so the gated session below is ours.
      await settle();

      const db = (h.queue as unknown as { db: { head: () => Promise<unknown> } })
        .db;
      const realHead = db.head.bind(db);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let gated = false;
      // Hold the drainer inside its first (empty) head() read.
      db.head = async () => {
        const result = await realHead();
        if (!gated) {
          gated = true;
          await gate;
        }
        return result;
      };

      const draining = h.queue.drain();
      await new Promise((r) => setTimeout(r, 0));
      expect(
        (h.queue as unknown as { draining: boolean }).draining
      ).toBe(true);

      await h.queue.enqueue(emit({ n: 1 }));
      release();
      await draining;
      await settle();

      // No backoff timer is armed on the idle path, so if the re-drain does not
      // happen the write is stranded indefinitely.
      expect(h.sent.map((w) => JSON.parse(w.body).n)).toEqual([1]);
    });
  });

  describe("records from a newer SDK", () => {
    /** What a sibling tab on a newer build leaves in the shared outbox. */
    function writeFutureRecord(dbName: string): Promise<void> {
      return withOutbox(dbName, (store) =>
        store.add({
          v: 99,
          localId: "from-the-future",
          idempotencyKey: "k",
          kind: "emit",
          serverUrl: "http://test:9123",
          environment: "default",
          body: "{}",
          bytes: 2,
          enqueuedAt: 1,
          identity: "user-1",
        })
      );
    }

    /** That sibling tab draining its own record away again. */
    function deleteFutureRecord(dbName: string): Promise<void> {
      return withOutbox(dbName, (store) => {
        const req = store.index("byLocalId").getKey("from-the-future");
        req.onsuccess = () => {
          if (req.result !== undefined) store.delete(req.result);
        };
      });
    }

    function withOutbox(
      dbName: string,
      fn: (store: IDBObjectStore) => void
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const r = indexedDB.open(dbName, 1);
        r.onsuccess = () => {
          const tx = r.result.transaction("outbox", "readwrite");
          fn(tx.objectStore("outbox"));
          tx.oncomplete = () => {
            r.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      });
    }

    it("blocks delivery and leaves them untouched", async () => {
      const h = await harness({ autoStart: false });
      await h.queue.start();
      await h.queue.enqueue(emit({ n: 1 }));
      await settle();

      const dbName = (h.queue as unknown as { opts: { dbName: string } }).opts.dbName;
      await h.queue.stop();

      // A newer build writes a record this SDK does not understand.
      await writeFutureRecord(dbName);

      const sent: QueuedWrite[] = [];
      const revived = new OfflineQueue({
        dbName,
        identity: "user-1",
        send: async (_path, w) => {
          sent.push(w);
          return {};
        },
        resolvePath: () => "/ironflow.v1.PubSubService/Emit",
        currentDestination: () => ({
          serverUrl: "http://test:9123",
          environment: "default",
        }),
        schedule: () => {},
      });
      live.push(revived);
      await revived.start();
      await settle();

      expect(revived.stats().state).toBe("blocked");
      expect(sent).toHaveLength(0);
      expect(await revived.deadLetter()).toEqual([]);
    });

    it("resumes once the future record is gone (#1609)", async () => {
      // A cross-version window is transient: the sibling tab that wrote the
      // unreadable record eventually drains it. `blocked` used to be terminal
      // for the life of the page — drain() early-returned on it and nothing
      // re-checked, so even a "Retry now" button silently did nothing.
      const h = await harness({ autoStart: false });
      const dbName = (h.queue as unknown as { opts: { dbName: string } }).opts
        .dbName;
      await h.queue.start();
      await h.queue.stop();
      await writeFutureRecord(dbName);

      const sent: QueuedWrite[] = [];
      const revived = new OfflineQueue({
        dbName,
        identity: "user-1",
        send: async (_path, w) => {
          sent.push(w);
          return {};
        },
        resolvePath: () => "/ironflow.v1.PubSubService/Emit",
        currentDestination: () => ({
          serverUrl: "http://test:9123",
          environment: "default",
        }),
        schedule: () => {},
      });
      live.push(revived);
      await revived.start();
      await revived.enqueue(emit({ n: 1 }));
      await settle();
      expect(revived.stats().state).toBe("blocked");
      expect(sent).toHaveLength(0);

      // The newer tab drains its own record and announces it; the outbox is
      // readable again. No flush() and no timer: the announce alone must get
      // delivery going, because nothing arms a retry while blocked.
      await deleteFutureRecord(dbName);
      const sibling = new BroadcastChannel(`ironflow-queue:${dbName}`);
      sibling.postMessage("changed");
      sibling.close();
      await settle();

      expect(sent.map((w) => JSON.parse(w.body).n)).toEqual([1]);
      expect(revived.stats()).toMatchObject({ pending: 0, state: "idle" });
    });
  });
});

describe("storage failures", () => {
  it("survives an IndexedDB failure mid-drain instead of stranding the queue", async () => {
    // Regression: drain() had try/finally but no catch, and every call site is
    // `void this.drain()`. A rejecting store call was an unhandled rejection AND
    // left stats() reporting "idle" with writes pending and no retry armed.
    const h = await harness();
    const unhandled: unknown[] = [];
    const onRejection = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onRejection);

    const db = (h.queue as unknown as { db: { head: () => Promise<unknown> } }).db;
    db.head = async () => {
      throw new DOMException("database is closed", "InvalidStateError");
    };

    await h.queue.enqueue(emit({ n: 1 }));
    await settle();
    process.off("unhandledRejection", onRejection);

    expect(unhandled).toHaveLength(0);
    // Pending work must never read as idle — that is the signal a UI trusts.
    expect(h.queue.stats().state).not.toBe("idle");
    expect(h.queue.stats().pending).toBe(1);
  });
});

describe("sibling refresh robustness (#1609 review)", () => {
  it("does not leak an unhandled rejection when the refresh chain fails", async () => {
    // The chain is fire-and-forget. stop() closing the database between two of
    // its awaits is the ordinary way it rejects, and reconcileWatchers reads
    // storage once per live watcher, so the window is not small.
    const h = await harness();
    const unhandled: unknown[] = [];
    const onRejection = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onRejection);

    const q = h.queue as unknown as {
      db: { usage: () => Promise<unknown> };
      opts: { dbName: string };
    };
    q.db.usage = async () => {
      throw new DOMException("database is closed", "InvalidStateError");
    };

    const sibling = new BroadcastChannel(`ironflow-queue:${q.opts.dbName}`);
    sibling.postMessage("changed");
    sibling.close();
    await settle();
    process.off("unhandledRejection", onRejection);

    expect(unhandled).toHaveLength(0);
  });

  it("re-reads a refresh that was discarded for racing a local mutation", async () => {
    // A discarded read used to be dropped outright. Nothing else re-runs a
    // refresh, so this tab stayed permanently blind to the sibling's row — and
    // blind in the permissive direction, so its cap then admitted extra writes.
    const h = await harness({
      send: async () => {
        throw httpError(503);
      },
    });
    const q = h.queue as unknown as {
      db: {
        usage: () => Promise<{ count: number; bytes: number }>;
        append: (w: unknown) => Promise<number>;
      };
      refreshCounters: () => Promise<void>;
    };
    const realUsage = q.db.usage.bind(q.db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    q.db.usage = async () => {
      const usage = await realUsage();
      if (!gated) {
        gated = true;
        await gate;
      }
      return usage;
    };

    const refresh = q.refreshCounters();
    await new Promise((r) => setTimeout(r, 0));
    // A sibling tab's row is already stored, invisible to our counters...
    await q.db.append({
      v: RECORD_VERSION,
      localId: "from-a-sibling",
      idempotencyKey: "k",
      kind: "emit",
      serverUrl: "http://test:9123",
      environment: "default",
      body: '{"n":0}',
      bytes: 7,
      enqueuedAt: 1_700_000_000_000,
      identity: "user-1",
    });
    // ...and a local enqueue makes the in-flight read unusable.
    await h.queue.enqueue(emit({ n: 1 }));
    release();
    await refresh;
    await settle();

    // Both rows counted: the retry read the store again after the race.
    expect(h.queue.stats().pending).toBe(2);
  });

  it("refuses to requeue a dead letter written by a newer SDK", async () => {
    // trimDeadLettered keeps these on purpose because this build cannot read
    // them. retry() would move one to the head of our own outbox and block
    // every write behind it.
    const h = await harness();
    const db = (
      h.queue as unknown as {
        db: {
          append: (w: unknown) => Promise<number>;
          head: () => Promise<unknown>;
          deadLetter: (e: unknown) => Promise<void>;
        };
      }
    ).db;
    await db.append({
      v: RECORD_VERSION + 1,
      localId: "from-the-future",
      idempotencyKey: "k",
      kind: "emit",
      serverUrl: "http://test:9123",
      environment: "default",
      body: "{}",
      bytes: 2,
      enqueuedAt: 1_700_000_000_000,
      identity: "user-1",
    });
    await db.deadLetter({
      write: await db.head(),
      reason: "rejected",
      message: "dead-lettered by a newer build",
      deadLetteredAt: 1_700_000_000_000,
    });

    await expect(h.queue.retry("from-the-future")).resolves.toBe(false);
    // Still quarantined, not resurrected into the outbox.
    expect(await h.queue.deadLetter()).toHaveLength(1);
    await settle();
    expect(h.queue.stats().state).not.toBe("blocked");
  });

  it("coalesces announces across the whole refresh cycle, not just its first microtask", async () => {
    // The flag was cleared on the first line inside the microtask, before any
    // await. Every announce therefore started its own pass — a full-store read
    // plus two indexed reads per live watcher — so a sibling draining N writes
    // cost N passes rather than one.
    const h = await harness();
    await settle();

    const q = h.queue as unknown as {
      db: { usage: () => Promise<{ count: number; bytes: number }> };
      opts: { dbName: string };
    };
    const realUsage = q.db.usage.bind(q.db);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.db.usage = async () => {
      calls += 1;
      await gate;
      return realUsage();
    };

    const sibling = new BroadcastChannel(`ironflow-queue:${q.opts.dbName}`);
    sibling.postMessage("changed");
    await new Promise((r) => setTimeout(r, 0));
    // Second announce lands while the first pass is still inside its DB read.
    sibling.postMessage("changed");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toBe(1);

    release();
    sibling.close();
    await settle();
  });
});

describe("byte accounting", () => {
  it("counts real bytes, not UTF-16 code units", async () => {
    // .length undercounts CJK/emoji by up to 3x, which would let the byte cap
    // admit far more than 5MB of actual stored data.
    const h = await harness({
      send: async () => {
        throw new IronflowError("offline", { code: "HTTP_503", retryable: true });
      },
    });
    const body = { note: "注文が確定しました 🎉" };
    await h.queue.enqueue(emit(body));
    await settle();

    const stored = (await h.queue.deadLetter()).length;
    expect(stored).toBe(0);
    const serialized = JSON.stringify({
      event: "e",
      data: body,
    });
    // The queue's own accounting must be >= the UTF-16 length for non-ASCII.
    expect(new TextEncoder().encode(serialized).length).toBeGreaterThan(
      serialized.length
    );
  });

  it("enforces the byte cap using real byte length", async () => {
    const h = await harness({
      send: async () => {
        throw new IronflowError("offline", { code: "HTTP_503", retryable: true });
      },
      // Under UTF-16 counting this body measured well under the cap.
      maxBytes: 60,
    });

    await expect(
      h.queue.enqueue(emit({ note: "注文が確定しました🎉注文が確定しました🎉" }))
    ).rejects.toBeInstanceOf(QueueFullError);
  });
});

describe("hardening (post-review)", () => {
  it("classifies 401 by HTTP status even when the body overrides the code", async () => {
    // A proxy or a Connect handler can put its own `code` in the body, which
    // send() passes through verbatim. Matching on the string would miss it and
    // dead-letter the write instead of pausing for re-auth.
    const connectStyle = new IronflowError("unauthenticated", {
      code: "unauthenticated",
      status: 401,
      retryable: false,
    });
    expect(classifyFailure(connectStyle)).toBe("auth");
  });

  it("quarantines a write enqueued for a different destination", async () => {
    // Queued against staging while offline, then the client is reconfigured to
    // production. The write must never land in prod.
    const h = await harness({
      send: async () => {
        throw httpError(503);
      },
    });
    await h.queue.enqueue(emit({ n: 1 }));
    await settle();
    expect(h.queue.stats().pending).toBe(1);

    const opts = (h.queue as unknown as {
      opts: { currentDestination: () => { serverUrl: string; environment: string } };
    }).opts;
    opts.currentDestination = () => ({
      serverUrl: "http://prod:9123",
      environment: "prod",
    });

    h.send.mockClear();
    await h.queue.flush();
    await settle();

    expect(h.send).not.toHaveBeenCalled();
    expect(h.lost.at(-1)).toMatchObject({ reason: "destination-mismatch" });
  });

  it("quarantines a record whose kind has no endpoint", async () => {
    const h = await harness();
    const opts = (h.queue as unknown as {
      opts: { resolvePath: (k: string) => string | null };
    }).opts;
    opts.resolvePath = () => null;

    await h.queue.enqueue(emit({ n: 1 }));
    await settle();

    expect(h.sent).toHaveLength(0);
    expect(h.lost.at(-1)).toMatchObject({ reason: "unknown-kind" });
  });

  it("rebinds identity when a different user signs in at the auth prompt", async () => {
    // The queue belongs to user-1. If user-2 logs in, user-1's writes must be
    // quarantined, not transmitted under user-2's credentials.
    const h = await harness({
      send: async () => {
        throw httpError(401);
      },
      onAuthRequired: async () => ({ identity: "user-2" }),
    });

    await h.queue.enqueue(emit({ owner: "user-1" }));
    await settle();

    expect(h.sent).toHaveLength(0);
    expect(h.lost.at(-1)).toMatchObject({ reason: "identity-mismatch" });
  });

  it("does not let a throwing subscriber reject an enqueue whose write is stored", async () => {
    // Otherwise the caller retries, generating a NEW idempotency key for a write
    // that is already queued — two distinct events server-side.
    const h = await harness();
    h.queue.subscribe(() => {
      throw new Error("subscriber blew up");
    });

    await expect(h.queue.enqueue(emit({ n: 1 }))).resolves.toMatchObject({
      localId: expect.any(String),
    });
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it("reserves capacity so concurrent enqueues cannot both pass the cap", async () => {
    const h = await harness({
      send: async () => {
        throw httpError(503);
      },
      maxItems: 1,
    });

    const results = await Promise.allSettled([
      h.queue.enqueue(emit({ n: 1 })),
      h.queue.enqueue(emit({ n: 2 })),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("does not let a sibling refresh clobber an in-flight reservation (#1609)", async () => {
    // refreshCounters overwrites pending/bytes wholesale from a DB read, while
    // enqueue reserves against the cap BEFORE its await. A sibling tab's
    // announce landing between the two left the counters permanently off by
    // one — in the permissive direction, so the cap then admitted writes past
    // its own limit.
    const h = await harness({
      send: async () => {
        throw httpError(503);
      },
    });
    const q = h.queue as unknown as {
      db: { usage: () => Promise<{ count: number; bytes: number }> };
      refreshCounters: () => Promise<void>;
    };
    const realUsage = q.db.usage.bind(q.db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    q.db.usage = async () => {
      const usage = await realUsage();
      if (!gated) {
        gated = true;
        await gate;
      }
      return usage;
    };

    // A sibling tab's announce arrives, so this tab re-reads the store...
    const refresh = q.refreshCounters();
    await new Promise((r) => setTimeout(r, 0));
    // ...and a write is enqueued here while that read is still in flight.
    await h.queue.enqueue(emit({ n: 1 }));
    release();
    await refresh;
    await settle();

    expect(h.queue.stats().pending).toBe(1);
  });

  it("never lets counter drift outlive an empty outbox (#1609)", async () => {
    // The flip side of discarding a raced refresh: nothing re-runs it, so a
    // read dropped while a sibling tab's write was already stored leaves this
    // tab under-counting — and draining both records then decrements past
    // zero. `pending` must never go negative, or the cap silently gains room.
    let fail = true;
    const h = await harness({
      send: async () => {
        if (fail) throw httpError(503);
        return {};
      },
    });
    const q = h.queue as unknown as {
      db: {
        usage: () => Promise<{ count: number; bytes: number }>;
        append: (w: unknown) => Promise<number>;
      };
      refreshCounters: () => Promise<void>;
    };
    const realUsage = q.db.usage.bind(q.db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    q.db.usage = async () => {
      const usage = await realUsage();
      if (!gated) {
        gated = true;
        await gate;
      }
      return usage;
    };

    const refresh = q.refreshCounters();
    await new Promise((r) => setTimeout(r, 0));
    // A sibling tab's write is already in the shared outbox...
    await q.db.append({
      v: RECORD_VERSION,
      localId: "from-a-sibling",
      idempotencyKey: "k",
      kind: "emit",
      serverUrl: "http://test:9123",
      environment: "default",
      body: '{"n":0}',
      bytes: 7,
      enqueuedAt: 1_700_000_000_000,
      identity: "user-1",
    });
    // ...and a local enqueue makes the in-flight read unusable.
    await h.queue.enqueue(emit({ n: 1 }));
    release();
    await refresh;

    fail = false;
    await h.queue.flush();
    await settle();

    expect(h.sent).toHaveLength(2);
    expect(h.queue.stats().pending).toBe(0);
  });

  it("cancels an armed retry on flush instead of leaving it running", async () => {
    let cancelled = 0;
    const h = await harness({
      send: async () => {
        throw httpError(503);
      },
    });
    const opts = (h.queue as unknown as {
      opts: { schedule: (fn: () => void, ms: number) => () => void };
    }).opts;
    opts.schedule = () => () => {
      cancelled += 1;
    };

    await h.queue.enqueue(emit({ n: 1 }));
    await settle();
    await h.queue.flush();

    expect(cancelled).toBeGreaterThan(0);
  });

  it("resolves a watcher from storage when the write already finished", async () => {
    // The post-reload case: watch() is called for a localId whose write landed
    // before this process existed, so nothing is in the in-memory map.
    const h = await harness();
    const { localId } = await h.queue.enqueue(emit({ n: 1 }));
    await settle();

    const seen: WriteStatus[] = [];
    h.queue.watch(localId, (s) => seen.push(s));
    await settle();

    expect(seen.at(-1)).toMatchObject({ status: "sent" });
  });

  it("does not let a stale unsubscribe orphan a later watcher (#1609)", async () => {
    // The unsubscribe closure captures the Set but deletes the map entry by
    // key. notifyWatcher already dropped that entry on the terminal status, so
    // a later watch() on the same localId built a NEW Set — which the old
    // unsubscribe then evicted, orphaning a live subscriber.
    let mode: "reject" | "hold" | "ok" = "reject";
    const h = await harness({
      send: async () => {
        if (mode === "reject") throw httpError(400, "nope");
        if (mode === "hold") throw httpError(503);
        return {};
      },
    });

    const seenA: WriteStatus[] = [];
    const seenB: WriteStatus[] = [];
    const { localId } = await h.queue.enqueue(emit({ n: 1 }));
    await settle();
    const offA = h.queue.watch(localId, (s) => seenA.push(s));
    await settle();
    expect(seenA.at(-1)).toMatchObject({ status: "lost" });

    // Back on the outbox under the SAME localId, still undelivered.
    mode = "hold";
    await h.queue.retry(localId);
    await settle();

    h.queue.watch(localId, (s) => seenB.push(s));
    await settle();
    expect(seenB.at(-1)).toEqual({ status: "pending" });

    // A's subscription finished long ago; dropping it must not evict B.
    offA();

    mode = "ok";
    await h.queue.flush();
    await settle();

    expect(seenB.at(-1)).toMatchObject({ status: "sent" });
  });

  it("gives every watcher on one localId its terminal status (#1609)", async () => {
    // Same root cause: the reconcile path deleted the whole map entry but only
    // fired its own callback, so a second watcher registered in the same tick
    // failed the "did a live notification beat us" guard and never heard back.
    const h = await harness({
      send: async () => {
        throw httpError(400, "nope");
      },
    });
    const { localId } = await h.queue.enqueue(emit({ n: 1 }));
    await settle();

    const seen1: WriteStatus[] = [];
    const seen2: WriteStatus[] = [];
    h.queue.watch(localId, (s) => seen1.push(s));
    h.queue.watch(localId, (s) => seen2.push(s));
    await settle();

    expect(seen1.at(-1)).toMatchObject({ status: "lost" });
    expect(seen2.at(-1)).toMatchObject({ status: "lost" });
  });

  it("keeps a dead-lettered write in exactly one place after retry", async () => {
    let bad = true;
    const h = await harness({
      send: async () => {
        if (bad) throw httpError(400, "nope");
        return {};
      },
    });
    const { localId } = await h.queue.enqueue(emit({ n: 1 }));
    await settle();
    expect(await h.queue.deadLetter()).toHaveLength(1);

    bad = false;
    await h.queue.retry(localId);
    await settle();

    // Neither duplicated into the outbox nor left behind in dead-letter.
    expect(await h.queue.deadLetter()).toEqual([]);
    expect(h.queue.stats().pending).toBe(0);
  });
});
