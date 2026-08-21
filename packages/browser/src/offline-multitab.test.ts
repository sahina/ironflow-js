/**
 * Multi-tab and re-authentication behaviour (ADR 0053, PR2).
 *
 * "Two tabs" is simulated by two OfflineQueue instances over one IndexedDB
 * database, which is exactly what two real tabs are. The Web Locks fake is
 * shared between them so the exclusion is real rather than assumed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { IronflowError } from "@ironflow/core";
import { OfflineQueue } from "./queue/queue.js";
import { createClient, type OfflineClient } from "./offline.js";
import type { QueuedWrite, QueueStats, WriteStatus } from "./queue/types.js";

let live: Array<{ stop: () => Promise<void> }> = [];
let n = 0;

afterEach(async () => {
  for (const q of live) await q.stop();
  live = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One LockManager shared by every "tab" in a test. */
function sharedLocks() {
  const held = new Set<string>();
  return {
    held,
    request: async (
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<unknown>
    ) => {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        throw new Error("test fake does not queue waiters");
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

function httpError(status: number) {
  return new IronflowError(`Request failed: ${status}`, {
    code: `HTTP_${status}`,
    retryable: status >= 500 || status === 429,
  });
}

async function settle() {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeQueue(
  dbName: string,
  send: (w: QueuedWrite) => Promise<{ eventId?: string }>,
  extra: Partial<ConstructorParameters<typeof OfflineQueue>[0]> = {}
) {
  const q = new OfflineQueue({
    dbName,
    identity: "user-1",
    send: (_path, w) => send(w),
    resolvePath: () => "/p",
    currentDestination: () => ({ serverUrl: "http://test", environment: "default" }),
    schedule: () => {},
    ...extra,
  });
  live.push(q);
  return q;
}

describe("two tabs over one database", () => {
  it("only one tab drains — the other sees the lock held", async () => {
    vi.stubGlobal("navigator", { locks: sharedLocks() });
    const dbName = `multitab-${n++}`;

    const senders: string[] = [];
    let releaseA!: () => void;
    const aInside = new Promise<void>((r) => (releaseA = r));

    const tabA = makeQueue(dbName, async () => {
      senders.push("A");
      await aInside;
      return {};
    });
    await tabA.start();
    await tabA.enqueue({ kind: "emit", body: { n: 1 } });
    await tabA.enqueue({ kind: "emit", body: { n: 2 } });
    await settle();

    // Tab B comes up while A holds the lock mid-send.
    const tabB = makeQueue(dbName, async () => {
      senders.push("B");
      return {};
    });
    await tabB.start();
    await settle();

    expect(senders).toEqual(["A"]);

    releaseA();
    await settle();
    // A finishes both writes; B never sent one behind its back.
    expect(senders.filter((s) => s === "B")).toHaveLength(0);
  });

  it("keeps a sibling tab's pending count honest via BroadcastChannel", async () => {
    // A Web Lock stops concurrent drains but does nothing for counters: without
    // a broadcast, tab B's badge would sit at 0 while tab A queues writes.
    vi.stubGlobal("navigator", { locks: sharedLocks() });
    const dbName = `counters-${n++}`;

    const blocked = async () => {
      throw httpError(503);
    };

    const tabA = makeQueue(dbName, blocked);
    const tabB = makeQueue(dbName, blocked);
    await tabA.start();
    await tabB.start();

    const seenB: QueueStats[] = [];
    tabB.subscribe((s) => seenB.push(s));
    expect(seenB.at(-1)!.pending).toBe(0);

    await tabA.enqueue({ kind: "emit", body: { n: 1 } });
    await settle();

    expect(seenB.at(-1)!.pending).toBe(1);
  });

  it("resolves a watcher for a write another tab drained (#1609)", async () => {
    // notifyWatcher only fires in the tab that did the draining, and the
    // BroadcastChannel handler used to re-read counters and nothing else. A
    // write enqueued in tab A and delivered by tab B left A's watcher on its
    // provisional "pending" forever — and leaked its entry for the life of the
    // page. Multi-tab is precisely what the channel was added for.
    vi.stubGlobal("navigator", { locks: sharedLocks() });
    const dbName = `watch-across-tabs-${n++}`;

    const tabA = makeQueue(dbName, async () => {
      throw httpError(503);
    });
    const tabB = makeQueue(dbName, async () => ({ eventId: "evt_b" }));
    await tabA.start();
    await tabB.start();

    const seen: WriteStatus[] = [];
    const { localId } = await tabA.enqueue({ kind: "emit", body: { n: 1 } });
    tabA.watch(localId, (s) => seen.push(s));
    await settle();
    expect(seen.at(-1)).toEqual({ status: "pending" });

    await tabB.flush();
    await settle();

    expect(seen.at(-1)).toMatchObject({ status: "sent" });
    // And the entry is released rather than leaking.
    expect(
      (tabA as unknown as { watchers: Map<string, unknown> }).watchers.size
    ).toBe(0);
  });

  it("works without BroadcastChannel — counters are simply tab-local", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const dbName = `no-bc-${n++}`;

    const q = makeQueue(dbName, async () => ({}));
    await q.start();
    await q.enqueue({ kind: "emit", body: { n: 1 } });
    await settle();

    expect(q.stats().pending).toBe(0);
  });
});

describe("re-authentication", () => {
  function okResponse(body: unknown = { eventId: "evt_1" }): Response {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }

  function unauthorized(): Response {
    const body = JSON.stringify({ message: "token expired", code: "HTTP_401" });
    return {
      ok: false,
      status: 401,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }

  it("refreshes the token and resends with the new credentials", async () => {
    const auths: Array<string | undefined> = [];
    let expired = true;

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      auths.push(headers["Authorization"]);
      return expired ? unauthorized() : okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAuthRequired = vi.fn(async () => {
      expired = false;
      return { token: "fresh-token" };
    });

    const client: OfflineClient = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      auth: { token: "stale-token" },
      offlineQueue: {
        identity: "user-1",
        dbName: `reauth-${n++}`,
        onAuthRequired,
      },
    });
    live.push({ stop: () => client.close() });

    await client.emit("order.placed", { id: 1 });
    await settle();

    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(auths[0]).toBe("Bearer stale-token");
    expect(auths.at(-1)).toBe("Bearer fresh-token");
    expect(client.queue.stats().pending).toBe(0);
  });

  it("keeps the existing credential when onAuthRequired returns only an identity", async () => {
    const auths: Array<string | undefined> = [];
    let calls = 0;

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      auths.push(headers["Authorization"]);
      // Succeed on the retry so the drain terminates; the assertion is about
      // which credential the retry carried, not about the 401 loop.
      return calls++ === 0 ? unauthorized() : okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    // Both AuthConfig fields are optional, so this typechecks. Spreading it
    // into setAuth() unguarded would clear the credential on the SHARED
    // client — subscriptions and every non-queue call included.
    const onAuthRequired = vi.fn(async () => ({ identity: "user-1" }));

    const client: OfflineClient = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      auth: { token: "still-good" },
      offlineQueue: {
        identity: "user-1",
        dbName: `reauth-identity-only-${n++}`,
        onAuthRequired,
      },
    });
    live.push({ stop: () => client.close() });

    await client.emit("order.placed", { id: 1 });
    await settle();

    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(auths.at(-1)).toBe("Bearer still-good");
    expect(client.queue.stats().pending).toBe(0);
  });

  it("does not dead-letter the write while waiting to re-authenticate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    const client = await createClient({
      serverUrl: "http://test:9123",
      logger: false,
      auth: { token: "stale" },
      offlineQueue: { identity: "user-1", dbName: `reauth-hold-${n++}` },
    });
    live.push({ stop: () => client.close() });

    await client.emit("order.placed", { id: 1 });
    await settle();

    // Pauses, keeps the write. A 401 is temporary by nature.
    expect(await client.queue.deadLetter()).toEqual([]);
    expect(client.queue.stats().pending).toBe(1);
  });

  it("releases the flush lock while paused, so another tab is not stuck", async () => {
    const locks = sharedLocks();
    vi.stubGlobal("navigator", { locks });
    const dbName = `lock-release-${n++}`;

    const q = makeQueue(dbName, async () => {
      throw httpError(401);
    });
    await q.start();
    await q.enqueue({ kind: "emit", body: { n: 1 } });
    await settle();

    expect(q.stats().state).toBe("paused");
    // The lock must be free even though the queue is still waiting on auth —
    // holding it across an unanswered login prompt would block every tab.
    expect(locks.held.size).toBe(0);
  });
});

describe("setAuth", () => {
  it("swaps credentials without tearing down the client", async () => {
    const seen: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["Authorization"]);
      return {
        ok: true,
        status: 200,
        text: async () => '{"eventId":"e"}',
        json: async () => ({ eventId: "e" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ironflow } = await import("./client.js");
    ironflow.configure({
      serverUrl: "http://test:9123",
      logger: false,
      auth: { apiKey: "first" },
    });

    await ironflow.emit("e", {});
    ironflow.setAuth({ apiKey: "second" });
    await ironflow.emit("e", {});

    expect(seen).toEqual(["Bearer first", "Bearer second"]);
    // Still configured — no teardown happened.
    expect(ironflow.isConfigured).toBe(true);
    ironflow._resetForTesting();
  });

  it("clears credentials when passed undefined", async () => {
    const seen: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>)["Authorization"]);
        return {
          ok: true,
          status: 200,
          text: async () => '{"eventId":"e"}',
          json: async () => ({ eventId: "e" }),
        } as unknown as Response;
      })
    );

    const { ironflow } = await import("./client.js");
    ironflow.configure({
      serverUrl: "http://test:9123",
      logger: false,
      auth: { apiKey: "first" },
    });

    ironflow.setAuth(undefined);
    await ironflow.emit("e", {});

    expect(seen[0]).toBeUndefined();
    ironflow._resetForTesting();
  });
});
