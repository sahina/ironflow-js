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
});
