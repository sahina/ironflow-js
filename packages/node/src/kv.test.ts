import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KVClient, KVBucketHandle } from "./kv.js";
import type { KVClientConfig } from "./kv.js";
import { assertDefined } from "./internal/assert-defined.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:9123";

function defaultConfig(overrides?: Partial<KVClientConfig>): KVClientConfig {
  return { serverUrl: BASE_URL, timeout: 5000, ...overrides };
}

function createMockResponse(status: number, body?: unknown): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastFetchCall() {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = assertDefined(calls[calls.length - 1]);
  return { url: url as string, init: init as RequestInit };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// KVClient – bucket operations
// ===========================================================================

describe("KVClient", () => {
  describe("createBucket", () => {
    it("should POST to /api/v1/kv/buckets and return bucket info", async () => {
      const bucketInfo = {
        name: "my-bucket",
        values: 0,
        bytes: 0,
        history: 1,
        created_at: "2026-01-01T00:00:00Z",
      };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(201, bucketInfo));

      const client = new KVClient(defaultConfig());
      const result = await client.createBucket({ name: "my-bucket" });

      expect(result).toEqual(bucketInfo);

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ name: "my-bucket" });
    });

    it("should include all optional config fields in request body", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(201, {
          name: "full-bucket",
          values: 0,
          bytes: 0,
          history: 5,
          created_at: "2026-01-01T00:00:00Z",
        })
      );

      const client = new KVClient(defaultConfig());
      await client.createBucket({
        name: "full-bucket",
        description: "A test bucket",
        ttlSeconds: 3600,
        maxValueSize: 1024,
        maxBytes: 1048576,
        history: 5,
      });

      const { init } = lastFetchCall();
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        name: "full-bucket",
        description: "A test bucket",
        ttl_seconds: 3600,
        max_value_size: 1024,
        max_bytes: 1048576,
        history: 5,
      });
    });
  });

  describe("deleteBucket", () => {
    it("should DELETE the bucket with URL-encoded name", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(204));

      const client = new KVClient(defaultConfig());
      await client.deleteBucket("my bucket");

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my%20bucket`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("listBuckets", () => {
    it("should GET /api/v1/kv/buckets and return buckets array", async () => {
      const buckets = [
        { name: "b1", values: 1, bytes: 100, history: 1, created_at: "2026-01-01T00:00:00Z" },
        { name: "b2", values: 5, bytes: 500, history: 3, created_at: "2026-01-02T00:00:00Z" },
      ];
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { buckets, count: 2 })
      );

      const client = new KVClient(defaultConfig());
      const result = await client.listBuckets();

      expect(result).toEqual(buckets);
      expect(result).toHaveLength(2);

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets`);
      expect(init.method).toBe("GET");
    });
  });

  describe("getBucketInfo", () => {
    it("should GET bucket info by name", async () => {
      const info = {
        name: "my-bucket",
        values: 10,
        bytes: 2048,
        history: 1,
        created_at: "2026-01-01T00:00:00Z",
      };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(200, info));

      const client = new KVClient(defaultConfig());
      const result = await client.getBucketInfo("my-bucket");

      expect(result).toEqual(info);
      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my-bucket`);
    });

    it("should throw on 404 not found", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(404, { error: "bucket not found" })
      );

      const client = new KVClient(defaultConfig());
      await expect(client.getBucketInfo("missing")).rejects.toThrow("bucket not found");
    });
  });

  describe("bucket()", () => {
    it("should return a KVBucketHandle instance", () => {
      const client = new KVClient(defaultConfig());
      const handle = client.bucket("test-bucket");
      expect(handle).toBeInstanceOf(KVBucketHandle);
    });
  });
});

// ===========================================================================
// KVBucketHandle – key operations
// ===========================================================================

describe("KVBucketHandle", () => {
  const config = defaultConfig();

  describe("get", () => {
    it("should GET the key and return a KVEntry", async () => {
      const entry = {
        key: "user:1",
        value: { name: "Alice" },
        revision: 3,
        created_at: "2026-01-01T00:00:00Z",
        operation: "put",
      };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(200, entry));

      const handle = new KVBucketHandle("my-bucket", config);
      const result = await handle.get("user:1");

      expect(result).toEqual(entry);
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my-bucket/keys/user:1`);
      expect(init.method).toBe("GET");
    });
  });

  describe("put", () => {
    it("should PUT the value and return revision", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { revision: 1 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      const result = await handle.put("key1", { foo: "bar" });

      expect(result).toEqual({ revision: 1 });
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my-bucket/keys/key1`);
      expect(init.method).toBe("PUT");
    });

    it("should use application/octet-stream for string values", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { revision: 2 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      await handle.put("key1", "raw-string-value");

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(init.body).toBe("raw-string-value");
    });

    it("should use application/json for object values", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { revision: 3 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      const obj = { nested: { data: true } };
      await handle.put("key1", obj);

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify(obj));
    });
  });

  describe("create", () => {
    it("should send If-None-Match: * header", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { revision: 1 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      await handle.create("new-key", { value: 42 });

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["If-None-Match"]).toBe("*");
      expect(init.method).toBe("PUT");
    });

    it("should throw on 412 conflict", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(412, { error: "key already exists" })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      await expect(handle.create("existing-key", "val")).rejects.toThrow(
        "key already exists"
      );
    });
  });

  describe("update", () => {
    it("should send If-Match header with revision number", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { revision: 6 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      await handle.update("key1", { updated: true }, 5);

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["If-Match"]).toBe("5");
      expect(init.method).toBe("PUT");
    });

    it("should throw on 412 revision mismatch", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(412, { error: "revision mismatch" })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      await expect(handle.update("key1", "val", 3)).rejects.toThrow(
        "revision mismatch"
      );
    });
  });

  describe("delete", () => {
    it("should DELETE the key", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(204));

      const handle = new KVBucketHandle("my-bucket", config);
      await handle.delete("key1");

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my-bucket/keys/key1`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("purge", () => {
    it("should DELETE the key with ?purge=true", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(204));

      const handle = new KVBucketHandle("my-bucket", config);
      await handle.purge("key1");

      const { url, init } = lastFetchCall();
      expect(url).toBe(
        `${BASE_URL}/api/v1/kv/buckets/my-bucket/keys/key1?purge=true`
      );
      expect(init.method).toBe("DELETE");
    });
  });

  describe("listKeys", () => {
    it("should GET keys and return string array", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { keys: ["a", "b", "c"], count: 3 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      const keys = await handle.listKeys();

      expect(keys).toEqual(["a", "b", "c"]);
      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/kv/buckets/my-bucket/keys`);
    });

    it("should include encoded filter in query string", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { keys: ["user.1", "user.2"], count: 2 })
      );

      const handle = new KVBucketHandle("my-bucket", config);
      const keys = await handle.listKeys("user.*");

      expect(keys).toEqual(["user.1", "user.2"]);
      const { url } = lastFetchCall();
      expect(url).toBe(
        `${BASE_URL}/api/v1/kv/buckets/my-bucket/keys?filter=${encodeURIComponent("user.*")}`
      );
    });
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe("Error handling", () => {
  const config = defaultConfig();

  it("should throw on server error (500) with status info", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 500 })
    );

    const client = new KVClient(config);
    await expect(client.listBuckets()).rejects.toThrow(
      "KV request failed with status 500"
    );
  });

  it("should extract error message from JSON response body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      createMockResponse(400, { error: "invalid bucket name" })
    );

    const client = new KVClient(config);
    await expect(client.createBucket({ name: "" })).rejects.toThrow(
      "invalid bucket name"
    );
  });

  it("should use plain text body as error message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 })
    );

    const client = new KVClient(config);
    await expect(client.listBuckets()).rejects.toThrow("service unavailable");
  });

  it("should fall back to status message when body is empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 403 })
    );

    const client = new KVClient(config);
    await expect(client.listBuckets()).rejects.toThrow(
      "KV request failed with status 403"
    );
  });
});

// ===========================================================================
// Auth
// ===========================================================================

describe("Auth", () => {
  it("should include Authorization header when apiKey is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      createMockResponse(200, { buckets: [], count: 0 })
    );

    const client = new KVClient(defaultConfig({ apiKey: "secret-key-123" }));
    await client.listBuckets();

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key-123");
  });

  it("should not include Authorization header when apiKey is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      createMockResponse(200, { buckets: [], count: 0 })
    );

    const client = new KVClient(defaultConfig());
    await client.listBuckets();

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("should include Authorization on bucket handle requests too", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      createMockResponse(200, {
        key: "k",
        value: "v",
        revision: 1,
        created_at: "2026-01-01T00:00:00Z",
        operation: "put",
      })
    );

    const handle = new KVBucketHandle(
      "my-bucket",
      defaultConfig({ apiKey: "handle-key" })
    );
    await handle.get("k");

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer handle-key");
  });
});
