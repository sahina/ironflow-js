import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandDedup } from "./command-dedup.js";
import { KVClient } from "./kv.js";
import { IronflowError } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";

const BASE_URL = "http://localhost:9123";

function config() {
  return { serverUrl: BASE_URL, timeout: 5000 };
}

function mockResponse(status: number, body?: unknown): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function kvEntry(key: string, value: unknown) {
  return {
    key,
    value: base64Json(value),
    revision: 1,
    operation: "put",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeDedup<T>(ttlSeconds = 604800) {
  const kv = new KVClient(config());
  return new CommandDedup<T>(kv, "test-bucket", ttlSeconds);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ensureBucket
// ---------------------------------------------------------------------------

describe("CommandDedup.ensureBucket", () => {
  it("createBucket called once and cached for subsequent calls", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" })) // createBucket
      .mockResolvedValueOnce(mockResponse(201, { revision: 1 })) // create cmd-1 (first tryClaim, wins)
      .mockResolvedValueOnce(mockResponse(201, { revision: 2 })); // create cmd-2 (second tryClaim, wins)

    const dedup = makeDedup<{ id: number }>();
    await dedup.tryClaim("cmd-1", { id: 0 });
    await dedup.tryClaim("cmd-2", { id: 0 });

    const postCalls = vi.mocked(fetch).mock.calls.filter(
      ([url]) => (url as string).includes("/kv/buckets") && !(url as string).includes("/keys/"),
    );
    expect(postCalls).toHaveLength(1);
  });

  it("409 from createBucket is treated as success (bucket already exists)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(409, { error: "bucket already exists" }))
      .mockResolvedValueOnce(mockResponse(201, {}));

    const dedup = makeDedup();
    await expect(dedup.tryClaim("cmd-1", {})).resolves.toBeNull();
  });

  it("non-409 error resets bucketReady so next call retries", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(503, { error: "unavailable" }))
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(201, {}));

    const dedup = makeDedup();
    await expect(dedup.tryClaim("cmd-1", {})).rejects.toBeInstanceOf(IronflowError);

    // second call retries createBucket and succeeds
    await expect(dedup.tryClaim("cmd-1", {})).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tryClaim
// ---------------------------------------------------------------------------

describe("CommandDedup.tryClaim", () => {
  it("winner: create succeeds → returns null", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(201, { revision: 1 }));

    const dedup = makeDedup<{ orderId: string }>();
    const result = await dedup.tryClaim("cmd-1", { orderId: "ord-1" });
    expect(result).toBeNull();
  });

  it("loser: create → 412 → reads prior entry → returns decoded T", async () => {
    const stored = { orderId: "ord-1", claimedAt: "2026-01-01T00:00:00Z" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(412, { error: "key already exists" }))
      .mockResolvedValueOnce(mockResponse(200, kvEntry("cmd-1", stored)));

    const dedup = makeDedup<typeof stored>();
    const result = await dedup.tryClaim("cmd-1", { orderId: "ord-2", claimedAt: "" });
    expect(result).toEqual(stored);
  });

  it("loser: prior missing (404 on get) → returns null", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(412, { error: "key already exists" }))
      .mockResolvedValueOnce(mockResponse(404, { error: "key not found" }));

    const dedup = makeDedup();
    const result = await dedup.tryClaim("cmd-1", {});
    expect(result).toBeNull();
  });

  it("non-412 error from create → re-throws", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(500, { error: "internal error" }));

    const dedup = makeDedup();
    await expect(dedup.tryClaim("cmd-1", {})).rejects.toBeInstanceOf(IronflowError);
  });

  it("loser with corrupt KV value → throws SyntaxError (fail-closed)", async () => {
    const corruptBase64 = Buffer.from("not-valid-json").toString("base64");
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(412, { error: "key already exists" }))
      .mockResolvedValueOnce(mockResponse(200, {
        key: "cmd-1", value: corruptBase64, revision: 1, operation: "put", created_at: "2026-01-01T00:00:00Z",
      }));

    const dedup = makeDedup();
    await expect(dedup.tryClaim("cmd-1", {})).rejects.toThrow(SyntaxError);
  });

  it("commandId with special chars is URL-encoded in the request path", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(201, { revision: 1 }));

    const dedup = makeDedup<{ id: string }>();
    await dedup.tryClaim("order/cmd-1", { id: "x" });

    const [url] = vi.mocked(fetch).mock.calls[1] as [string, ...unknown[]];
    expect(url).toContain("order%2Fcmd-1");
    expect(url).not.toContain("order/cmd-1");
  });
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe("CommandDedup.finalize", () => {
  it("serializes result as JSON string and calls kv.put", async () => {
    const result = { orderId: "ord-1", entityVersion: 3 };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(200, { revision: 2 }));

    const dedup = makeDedup<typeof result>();
    await dedup.finalize("cmd-1", result);

    const [, putInit] = assertDefined(vi.mocked(fetch).mock.calls[1]);
    expect((putInit as RequestInit).method).toBe("PUT");
    expect((putInit as RequestInit).body).toBe(JSON.stringify(result));
  });

  it("error from kv.put propagates", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(500, { error: "server error" }));

    const dedup = makeDedup();
    await expect(dedup.finalize("cmd-1", {})).rejects.toBeInstanceOf(IronflowError);
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

describe("CommandDedup.release", () => {
  it("calls kv.delete", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(204));

    const dedup = makeDedup();
    await expect(dedup.release("cmd-1")).resolves.toBeUndefined();
  });

  it("404 from delete is swallowed (idempotent)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(404, { error: "key not found" }));

    const dedup = makeDedup();
    await expect(dedup.release("cmd-1")).resolves.toBeUndefined();
  });

  it("non-404 error from delete re-throws", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      .mockResolvedValueOnce(mockResponse(500, { error: "server error" }));

    const dedup = makeDedup();
    await expect(dedup.release("cmd-1")).rejects.toBeInstanceOf(IronflowError);
  });
});

// ---------------------------------------------------------------------------
// concurrent tryClaim — race safety
// ---------------------------------------------------------------------------

describe("CommandDedup.tryClaim concurrent", () => {
  it("two concurrent callers: one wins (null), one loses (prior entry returned)", async () => {
    const stored = { orderId: "ord-1", claimedAt: "2026-01-01T00:00:00Z" };

    // Bucket creation (shared — first call only because bucketReady is Promise-cached)
    // We need two separate dedup instances to simulate two concurrent callers,
    // since a single instance caches bucketReady and only creates the bucket once.
    const kv1 = new KVClient(config());
    const kv2 = new KVClient(config());
    const winner = new CommandDedup<typeof stored>(kv1, "test-bucket");
    const loser = new CommandDedup<typeof stored>(kv2, "test-bucket");

    // Interleaved fetch sequence for two concurrent callers:
    // winner: createBucket(201) → create(201)
    // loser:  createBucket(409) → create(412) → get(200)
    vi.mocked(fetch)
      // winner: createBucket
      .mockResolvedValueOnce(mockResponse(201, { name: "test-bucket", values: 0, bytes: 0, history: 1, created_at: "" }))
      // loser: createBucket (bucket already exists)
      .mockResolvedValueOnce(mockResponse(409, { error: "bucket already exists" }))
      // winner: create wins
      .mockResolvedValueOnce(mockResponse(201, { revision: 1 }))
      // loser: create loses (412 conflict)
      .mockResolvedValueOnce(mockResponse(412, { error: "key already exists" }))
      // loser: reads winner's stored entry
      .mockResolvedValueOnce(mockResponse(200, kvEntry("cmd-1", stored)));

    const [winnerResult, loserResult] = await Promise.all([
      winner.tryClaim("cmd-1", { orderId: "ord-winner", claimedAt: "" }),
      loser.tryClaim("cmd-1", { orderId: "ord-loser", claimedAt: "" }),
    ]);

    expect(winnerResult).toBeNull();
    expect(loserResult).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------
// throwTypedError regression — HTTP_412 code
// ---------------------------------------------------------------------------

describe("throwTypedError regression", () => {
  it("status 412 produces IronflowError with code HTTP_412", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(412, { error: "key already exists" }));

    const kv = new KVClient(config());
    const bucket = kv.bucket("test-bucket");
    let caughtCode: string | undefined;
    try {
      await bucket.create("test-key", "value");
    } catch (err) {
      if (err instanceof IronflowError) caughtCode = err.code;
    }
    expect(caughtCode).toBe("HTTP_412");
  });
});
