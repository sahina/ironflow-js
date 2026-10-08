import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetryEvent } from "@ironflow/core";
import { createClient } from "./client.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** Stub fetch with a queue of replies; the last reply repeats. Returns the call counter. */
function stubFetch(...replies: Array<() => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async () => {
    const reply = replies[Math.min(fetchMock.mock.calls.length, replies.length) - 1];
    return reply!();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Run every pending timer (backoff sleeps), then return the settled promise. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

const unavailable = () => json(503, { code: "unavailable", message: "try later" });
const serverUrl = "http://localhost:9123";

describe("client retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a 503 on an RPC the proto marks NO_SIDE_EFFECTS", async () => {
    const fetchMock = stubFetch(unavailable, () => json(200, { functions: [] }));

    await expect(settle(createClient({ serverUrl }).listFunctions())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 503 on a mutating RPC", async () => {
    const fetchMock = stubFetch(unavailable);

    await expect(settle(createClient({ serverUrl }).emit("order.placed", {}))).rejects.toThrow("try later");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for Retry-After, then retries a 429 on a mutating RPC", async () => {
    const fetchMock = stubFetch(
      () => json(429, { code: "resource_exhausted", message: "slow down" }, { "Retry-After": "2" }),
      () => json(200, { runIds: [], eventId: "evt_1" }),
    );

    const result = createClient({ serverUrl }).emit("order.placed", {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toMatchObject({ eventId: "evt_1" });
  });

  it("clamps Retry-After to maxDelayMs", async () => {
    stubFetch(
      () => json(429, { message: "slow down" }, { "Retry-After": "86400" }),
      () => json(200, { functions: [] }),
    );
    const events: RetryEvent[] = [];

    await settle(createClient({ serverUrl, retry: { onRetry: (e) => events.push(e) } }).listFunctions());
    expect(events.map((e) => e.delayMs)).toEqual([10_000]);
  });

  it("backs off exponentially, gives up after maxAttempts and reports the last error once", async () => {
    const fetchMock = stubFetch(unavailable);
    const events: RetryEvent[] = [];
    const onError = vi.fn();
    const client = createClient({ serverUrl, onError, retry: { onRetry: (e) => events.push(e) } });

    await expect(settle(client.listFunctions())).rejects.toThrow("try later");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.map((e) => [e.attempt, e.maxAttempts, e.delayMs])).toEqual([
      [1, 3, 100],
      [2, 3, 200],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("makes one attempt when maxAttempts is 1", async () => {
    const fetchMock = stubFetch(unavailable);
    const client = createClient({ serverUrl, retry: { maxAttempts: 1 } });

    await expect(settle(client.listFunctions())).rejects.toThrow("try later");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 on a REST GET", async () => {
    const fetchMock = stubFetch(unavailable, () => json(200, []));

    await expect(settle(createClient({ serverUrl }).apiKeys.list())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 503 on a REST POST", async () => {
    const fetchMock = stubFetch(unavailable);

    await expect(settle(createClient({ serverUrl }).apiKeys.create({ name: "ci" }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network error on a read after connectionRetryDelayMs", async () => {
    const fetchMock = stubFetch(
      () => Promise.reject(new TypeError("fetch failed")),
      () => json(200, { workers: [] }),
    );
    const events: RetryEvent[] = [];
    const client = createClient({ serverUrl, retry: { onRetry: (e) => events.push(e) } });

    await expect(settle(client.listWorkers())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.delayMs)).toEqual([2000]);
  });

  it("does not retry a network error on a mutating RPC", async () => {
    const fetchMock = stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    await expect(settle(createClient({ serverUrl }).emit("order.placed", {}))).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("server retry signal", () => {
    it("does not retry a 501 on a safe call", async () => {
      const fetchMock = stubFetch(() => json(501, { error: "unimplemented", retryable: false }));

      await expect(settle(createClient({ serverUrl }).apiKeys.list())).rejects.toMatchObject({ retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 501 on a safe RPC", async () => {
      const fetchMock = stubFetch(() => json(501, { code: "unimplemented", message: "no such rpc" }));

      await expect(settle(createClient({ serverUrl }).listFunctions())).rejects.toThrow("no such rpc");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a safe call whose 503 body says retryable false", async () => {
      const fetchMock = stubFetch(() => json(503, { error: "disk full", message: "disk full", retryable: false }));

      await expect(settle(createClient({ serverUrl }).apiKeys.list())).rejects.toMatchObject({ retryable: false, status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still retries a safe 503 whose body says retryable true", async () => {
      const fetchMock = stubFetch(() => json(503, { error: "busy", retryable: true }), () => json(200, []));

      await expect(settle(createClient({ serverUrl }).apiKeys.list())).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reads retryable from a REST error body", async () => {
      stubFetch(() => json(400, { error: "later", retryable: true }));
      await expect(settle(createClient({ serverUrl }).apiKeys.create({ name: "ci" }))).rejects.toMatchObject({ retryable: true, status: 400 });

      stubFetch(() => json(409, { error: "busy", retryable: true }));
      await expect(settle(createClient({ serverUrl }).apiKeys.create({ name: "ci" }))).rejects.toMatchObject({ retryable: true });
    });

    it("falls back to the status rule when the body has no retryable", async () => {
      stubFetch(() => json(500, { error: "boom" }));
      await expect(settle(createClient({ serverUrl, retry: { maxAttempts: 1 } }).apiKeys.list())).rejects.toMatchObject({ retryable: true });

      stubFetch(() => json(404, { error: "gone" }));
      await expect(settle(createClient({ serverUrl }).apiKeys.list())).rejects.toMatchObject({ retryable: false });
    });

    it("waits for the body retry_after when there is no Retry-After header", async () => {
      stubFetch(() => json(429, { error: "slow down", retryable: true, retry_after: 3 }), () => json(200, []));
      const events: RetryEvent[] = [];

      await settle(createClient({ serverUrl, retry: { onRetry: (e) => events.push(e) } }).apiKeys.list());
      expect(events.map((e) => e.delayMs)).toEqual([3000]);
    });

    it("prefers the Retry-After header and clamps the body retry_after to maxDelayMs", async () => {
      stubFetch(() => json(429, { error: "slow", retry_after: 3 }, { "Retry-After": "5" }), () => json(200, []));
      const header: RetryEvent[] = [];
      await settle(createClient({ serverUrl, retry: { onRetry: (e) => header.push(e) } }).apiKeys.list());
      expect(header.map((e) => e.delayMs)).toEqual([5000]);

      stubFetch(() => json(429, { error: "slow", retry_after: 86400 }), () => json(200, []));
      const clamped: RetryEvent[] = [];
      await settle(createClient({ serverUrl, retry: { onRetry: (e) => clamped.push(e) } }).apiKeys.list());
      expect(clamped.map((e) => e.delayMs)).toEqual([10_000]);
    });

    it("still resends a write only on 429", async () => {
      const fetchMock = stubFetch(() => json(503, { error: "busy", retryable: true }));

      await expect(settle(createClient({ serverUrl }).apiKeys.create({ name: "ci" }))).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
