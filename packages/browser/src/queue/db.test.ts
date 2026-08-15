import { describe, it, expect, afterEach } from "vitest";
import { QueueDb, QueueVersionError, type NewQueuedWrite } from "./db.js";
import { RECORD_VERSION, type DeadLetteredWrite } from "./types.js";

let open: QueueDb[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

async function openDb(name = "test-queue"): Promise<QueueDb> {
  const db = await QueueDb.open(name);
  open.push(db);
  return db;
}

function write(overrides: Partial<NewQueuedWrite> = {}): NewQueuedWrite {
  const body = overrides.body ?? '{"event":"order.placed"}';
  return {
    v: RECORD_VERSION,
    localId: overrides.localId ?? `local-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: overrides.idempotencyKey ?? "idem-1",
    kind: overrides.kind ?? "emit",
    serverUrl: overrides.serverUrl ?? "http://test:9123",
    environment: overrides.environment ?? "default",
    body,
    bytes: overrides.bytes ?? body.length,
    enqueuedAt: overrides.enqueuedAt ?? 1_700_000_000_000,
    identity: overrides.identity ?? "user-1",
    ...overrides,
  };
}

describe("QueueDb", () => {
  describe("open", () => {
    it("creates both stores and the localId index", async () => {
      const db = await openDb();
      // Exercised via the API rather than poking at internals.
      await db.append(write({ localId: "a" }));
      await expect(db.findByLocalId("a")).resolves.toMatchObject({ localId: "a" });
      await expect(db.listDeadLettered()).resolves.toEqual([]);
    });

    it("reopens an existing database without losing writes", async () => {
      const first = await openDb("persist-me");
      await first.append(write({ localId: "survivor" }));
      first.close();

      const second = await openDb("persist-me");
      await expect(second.head()).resolves.toMatchObject({ localId: "survivor" });
    });

    it("throws QueueVersionError when the stored database is newer", async () => {
      // Simulate a newer SDK having created version 2.
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("from-the-future", 2);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        };
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      });

      await expect(QueueDb.open("from-the-future")).rejects.toBeInstanceOf(
        QueueVersionError
      );
    });
  });

  describe("outbox FIFO", () => {
    it("assigns increasing keys and returns the oldest first", async () => {
      const db = await openDb();
      const a = await db.append(write({ localId: "a" }));
      const b = await db.append(write({ localId: "b" }));
      const c = await db.append(write({ localId: "c" }));

      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
      await expect(db.head()).resolves.toMatchObject({ localId: "a" });
    });

    it("advances to the next write only after the head is removed", async () => {
      const db = await openDb();
      await db.append(write({ localId: "a" }));
      await db.append(write({ localId: "b" }));

      const head = await db.head();
      expect(head!.localId).toBe("a");

      // Head stays put until explicitly removed — this is what makes the queue
      // blocking rather than skip-ahead.
      await expect(db.head()).resolves.toMatchObject({ localId: "a" });

      await db.remove(head!.seq);
      await expect(db.head()).resolves.toMatchObject({ localId: "b" });
    });

    it("returns undefined for an empty outbox", async () => {
      const db = await openDb();
      await expect(db.head()).resolves.toBeUndefined();
    });

    it("stores the record version and body bytes verbatim", async () => {
      const db = await openDb();
      await db.append(write({ localId: "a", body: '{"a":1}', bytes: 7 }));

      const head = await db.head();
      expect(head).toMatchObject({ v: RECORD_VERSION, body: '{"a":1}', bytes: 7 });
    });
  });

  describe("usage", () => {
    it("reports zero for an empty outbox", async () => {
      const db = await openDb();
      await expect(db.usage()).resolves.toEqual({ count: 0, bytes: 0 });
    });

    it("sums item count and bytes", async () => {
      const db = await openDb();
      await db.append(write({ localId: "a", bytes: 100 }));
      await db.append(write({ localId: "b", bytes: 250 }));

      await expect(db.usage()).resolves.toEqual({ count: 2, bytes: 350 });
    });
  });

  describe("future records", () => {
    it("reports none for records this SDK understands", async () => {
      const db = await openDb();
      await db.append(write({ localId: "a" }));
      await expect(db.hasFutureRecords()).resolves.toBe(false);
    });

    it("detects a record written by a newer SDK", async () => {
      const db = await openDb();
      await db.append(write({ localId: "a" }));
      await db.append(write({ localId: "future", v: RECORD_VERSION + 1 }));

      await expect(db.hasFutureRecords()).resolves.toBe(true);
    });

    it("leaves the future record in place — it is never removed as a side effect", async () => {
      const db = await openDb();
      await db.append(write({ localId: "future", v: 99 }));

      await db.hasFutureRecords();
      await expect(db.findByLocalId("future")).resolves.toMatchObject({ v: 99 });
    });
  });

  describe("dead letter", () => {
    function dead(w: Awaited<ReturnType<QueueDb["head"]>>): DeadLetteredWrite {
      return {
        write: w!,
        reason: "rejected",
        message: "400 bad request",
        deadLetteredAt: 1_700_000_000_500,
      };
    }

    it("moves a write out of the outbox atomically", async () => {
      const db = await openDb();
      await db.append(write({ localId: "bad" }));
      await db.append(write({ localId: "good" }));

      await db.deadLetter(dead(await db.head()));

      await expect(db.head()).resolves.toMatchObject({ localId: "good" });
      await expect(db.findByLocalId("bad")).resolves.toBeUndefined();
      await expect(db.countDeadLettered()).resolves.toBe(1);
    });

    it("lists entries oldest-first with their reason and message", async () => {
      const db = await openDb();
      await db.append(write({ localId: "x" }));
      const first = dead(await db.head());
      await db.deadLetter(first);

      await db.append(write({ localId: "y" }));
      const second = { ...dead(await db.head()), deadLetteredAt: first.deadLetteredAt + 10 };
      await db.deadLetter(second);

      const list = await db.listDeadLettered();
      expect(list.map((e) => e.write.localId)).toEqual(["x", "y"]);
      expect(list[0]).toMatchObject({ reason: "rejected", message: "400 bad request" });
    });

    it("discards by localId and reports whether anything was removed", async () => {
      const db = await openDb();
      await db.append(write({ localId: "x" }));
      await db.deadLetter(dead(await db.head()));

      await expect(db.discardDeadLettered("x")).resolves.toBe(true);
      await expect(db.countDeadLettered()).resolves.toBe(0);
      await expect(db.discardDeadLettered("x")).resolves.toBe(false);
    });

    it("reads both stores in one transaction, so a moving record is never absent", async () => {
      // deadLetter() moves a record between the stores atomically. Two separate
      // reads could miss it in both and report a LOST write as delivered.
      const db = await openDb();
      await db.append(write({ localId: "moving" }));
      const head = await db.head();

      // Issued in the same tick: the move runs while the status read is open.
      const reading = db.statusOf("moving");
      const moving = db.deadLetter(dead(head));
      const [status] = await Promise.all([reading, moving]);

      expect(status.kind).not.toBe("absent");
      await expect(db.statusOf("moving")).resolves.toMatchObject({ kind: "dead" });
      await expect(db.statusOf("never-existed")).resolves.toEqual({
        kind: "absent",
      });
    });

    it("fetches a single entry so it can be replayed", async () => {
      const db = await openDb();
      await db.append(write({ localId: "x", body: '{"replay":true}' }));
      await db.deadLetter(dead(await db.head()));

      const entry = await db.getDeadLettered("x");
      expect(entry?.write.body).toBe('{"replay":true}');
      await expect(db.getDeadLettered("nope")).resolves.toBeUndefined();
    });

    it("trims to the cap, dropping oldest first", async () => {
      const db = await openDb();
      for (let i = 0; i < 5; i++) {
        await db.append(write({ localId: `d${i}` }));
        const head = await db.head();
        await db.deadLetter({ ...dead(head), deadLetteredAt: 1_700_000_000_000 + i });
      }

      await db.trimDeadLettered(3);

      const list = await db.listDeadLettered();
      expect(list.map((e) => e.write.localId)).toEqual(["d2", "d3", "d4"]);
    });

    it("leaves the store alone when it is under the cap", async () => {
      const db = await openDb();
      await db.append(write({ localId: "only" }));
      await db.deadLetter(dead(await db.head()));

      await db.trimDeadLettered(10);
      await expect(db.countDeadLettered()).resolves.toBe(1);
    });

    it("counts non-evictable records against the cap (#1609)", async () => {
      // A record from a newer SDK is never evicted — correct, this build cannot
      // read it. But the cap used to be measured against the evictable subset
      // alone, so the store kept `max` evictable records PLUS every future one:
      // no upper bound at all whenever a future record is present.
      const db = await openDb();
      await db.append(write({ localId: "future", v: RECORD_VERSION + 1 }));
      await db.deadLetter({ ...dead(await db.head()), deadLetteredAt: 1 });
      for (let i = 0; i < 4; i++) {
        await db.append(write({ localId: `d${i}` }));
        await db.deadLetter({ ...dead(await db.head()), deadLetteredAt: 10 + i });
      }

      await db.trimDeadLettered(2);

      const list = await db.listDeadLettered();
      expect(list).toHaveLength(2);
      // The unreadable one survives; the excess is taken out of the evictable.
      expect(list.map((e) => e.write.localId)).toEqual(["future", "d3"]);
    });

    // Invariant guard, NOT a regression detector for #1609: with nothing
    // evictable both the old and the new arithmetic delete nothing, so this
    // passes either way. It exists to stop a future cap fix from reaching for
    // records this build cannot read. The mixed-population test above is the
    // one that fails on a revert.
    it("keeps every non-evictable record even when they alone exceed the cap", async () => {
      const db = await openDb();
      for (let i = 0; i < 3; i++) {
        await db.append(write({ localId: `f${i}`, v: RECORD_VERSION + 1 }));
        await db.deadLetter({ ...dead(await db.head()), deadLetteredAt: i });
      }

      await db.trimDeadLettered(1);

      // Nothing deletable: data written by a newer build is never destroyed.
      await expect(db.countDeadLettered()).resolves.toBe(3);
    });
  });
});
