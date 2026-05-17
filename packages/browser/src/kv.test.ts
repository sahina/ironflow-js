import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IronflowError, HEADERS } from "@ironflow/core";
import type { KVBucketInfo, KVEntry, KVWatchEvent } from "@ironflow/core";
import type { IronflowConfig } from "./config.js";
import { BrowserKVClient, BrowserKVBucketHandle } from "./kv.js";
import { assertDefined } from "./internal/assert-defined.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<IronflowConfig>): IronflowConfig {
  return {
    serverUrl: "http://localhost:9123",
    transport: "connectrpc",
    reconnect: {
      enabled: true,
      maxAttempts: 10,
      backoff: { initial: 1000, max: 30000, multiplier: 2 },
    },
    visibility: { pauseOnHidden: true, reconnectOnVisible: true },
    environment: "test-env",
    ...overrides,
  };
}

/** Shorthand to build a mock Response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function errorResponse(status: number, body?: string | object): Response {
  const text =
    typeof body === "object" ? JSON.stringify(body) : (body ?? "");
  return new Response(text, { status });
}

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockWebSocket.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// BrowserKVClient – Bucket operations
// ===========================================================================

describe("BrowserKVClient", () => {
  const config = makeConfig();

  // ---- createBucket -------------------------------------------------------

  describe("createBucket", () => {
    it("sends POST and returns KVBucketInfo", async () => {
      const bucketInfo: KVBucketInfo = {
        name: "my-bucket",
        values: 0,
        bytes: 0,
        history: 1,
        created_at: "2026-01-01T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(bucketInfo, 201));

      const client = new BrowserKVClient(config);
      const result = await client.createBucket({ name: "my-bucket" });

      expect(result).toEqual(bucketInfo);

      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/kv/buckets");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({ name: "my-bucket" });
    });

    it("maps all config fields correctly in the request body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          name: "full-bucket",
          values: 0,
          bytes: 0,
          history: 5,
          created_at: "2026-01-01T00:00:00Z",
        })
      );

      const client = new BrowserKVClient(config);
      await client.createBucket({
        name: "full-bucket",
        description: "A test bucket",
        ttlSeconds: 3600,
        maxValueSize: 1024,
        maxBytes: 65536,
        history: 5,
      });

      const body = JSON.parse(
        assertDefined(mockFetch.mock.calls[0]?.[1]).body as string
      );
      expect(body).toEqual({
        name: "full-bucket",
        description: "A test bucket",
        ttl_seconds: 3600,
        max_value_size: 1024,
        max_bytes: 65536,
        history: 5,
      });
    });
  });

  // ---- deleteBucket -------------------------------------------------------

  describe("deleteBucket", () => {
    it("sends DELETE with URL-encoded name", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse());

      const client = new BrowserKVClient(config);
      await client.deleteBucket("my bucket");

      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/my%20bucket"
      );
      expect(options.method).toBe("DELETE");
    });
  });

  // ---- listBuckets --------------------------------------------------------

  describe("listBuckets", () => {
    it("returns array of KVBucketInfo", async () => {
      const buckets: KVBucketInfo[] = [
        {
          name: "a",
          values: 1,
          bytes: 100,
          history: 1,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          name: "b",
          values: 2,
          bytes: 200,
          history: 3,
          created_at: "2026-01-02T00:00:00Z",
        },
      ];
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ buckets, count: 2 })
      );

      const client = new BrowserKVClient(config);
      const result = await client.listBuckets();

      expect(result).toEqual(buckets);
      const [url] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/kv/buckets");
    });
  });

  // ---- getBucketInfo ------------------------------------------------------

  describe("getBucketInfo", () => {
    it("returns bucket info on 200", async () => {
      const info: KVBucketInfo = {
        name: "test",
        values: 5,
        bytes: 512,
        history: 1,
        created_at: "2026-01-01T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(info));

      const client = new BrowserKVClient(config);
      const result = await client.getBucketInfo("test");

      expect(result).toEqual(info);
    });

    it("throws IronflowError with HTTP_404 on not found", async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(404, { error: "bucket not found" })
      );

      const client = new BrowserKVClient(config);

      try {
        await client.getBucketInfo("missing");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(IronflowError);
        const e = err as IronflowError;
        expect(e.code).toBe("HTTP_404");
        expect(e.retryable).toBe(false);
      }
    });
  });

  // ---- bucket() -----------------------------------------------------------

  describe("bucket()", () => {
    it("returns a BrowserKVBucketHandle", () => {
      const client = new BrowserKVClient(config);
      const handle = client.bucket("my-bucket");

      expect(handle).toBeInstanceOf(BrowserKVBucketHandle);
    });
  });
});

// ===========================================================================
// BrowserKVBucketHandle – Key operations
// ===========================================================================

describe("BrowserKVBucketHandle", () => {
  const config = makeConfig();
  let handle: BrowserKVBucketHandle;

  beforeEach(() => {
    handle = new BrowserKVBucketHandle("test-bucket", config);
  });

  // ---- get ----------------------------------------------------------------

  describe("get", () => {
    it("sends GET and returns KVEntry", async () => {
      const entry: KVEntry = {
        key: "mykey",
        value: "hello",
        revision: 1,
        created_at: "2026-01-01T00:00:00Z",
        operation: "put",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(entry));

      const result = await handle.get("mykey");

      expect(result).toEqual(entry);
      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys/mykey"
      );
      expect(options.method).toBe("GET");
    });
  });

  // ---- put ----------------------------------------------------------------

  describe("put", () => {
    it("sends PUT and returns revision", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ revision: 3 }));

      const result = await handle.put("mykey", { foo: "bar" });

      expect(result).toEqual({ revision: 3 });
      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys/mykey"
      );
      expect(options.method).toBe("PUT");
    });

    it("sets Content-Type to application/octet-stream for string values", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ revision: 1 }));

      await handle.put("mykey", "raw-string-value");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("sets Content-Type to application/json for object values", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ revision: 1 }));

      await handle.put("mykey", { nested: true });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  // ---- create (if-not-exists) ---------------------------------------------

  describe("create", () => {
    it("sends If-None-Match: * header", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ revision: 1 }));

      await handle.create("newkey", { data: 1 });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["If-None-Match"]).toBe("*");
    });

    it("throws IronflowError on 412 conflict", async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(412, { error: "key already exists" })
      );

      try {
        await handle.create("existing", "val");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(IronflowError);
        const e = err as IronflowError;
        expect(e.code).toBe("HTTP_412");
        expect(e.retryable).toBe(false);
      }
    });
  });

  // ---- update (compare-and-swap) ------------------------------------------

  describe("update", () => {
    it("sends If-Match header with revision", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ revision: 5 }));

      await handle.update("mykey", { v: 2 }, 4);

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["If-Match"]).toBe("4");
    });

    it("throws IronflowError on 412 revision mismatch", async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(412, { error: "revision mismatch" })
      );

      try {
        await handle.update("mykey", "val", 99);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(IronflowError);
        const e = err as IronflowError;
        expect(e.code).toBe("HTTP_412");
        expect(e.retryable).toBe(false);
      }
    });
  });

  // ---- delete -------------------------------------------------------------

  describe("delete", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse());

      await handle.delete("mykey");

      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys/mykey"
      );
      expect(options.method).toBe("DELETE");
    });
  });

  // ---- purge --------------------------------------------------------------

  describe("purge", () => {
    it("sends DELETE with ?purge=true", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse());

      await handle.purge("mykey");

      const [url, options] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys/mykey?purge=true"
      );
      expect(options.method).toBe("DELETE");
    });
  });

  // ---- listKeys -----------------------------------------------------------

  describe("listKeys", () => {
    it("returns array of keys", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ keys: ["a", "b", "c"], count: 3 })
      );

      const keys = await handle.listKeys();

      expect(keys).toEqual(["a", "b", "c"]);
      const [url] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys"
      );
    });

    it("includes filter in URL when provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ keys: ["user.1", "user.2"], count: 2 })
      );

      await handle.listKeys("user.*");

      const [url] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/kv/buckets/test-bucket/keys?filter=user.*"
      );
    });
  });
});

// ===========================================================================
// IronflowError handling
// ===========================================================================

describe("IronflowError handling", () => {
  const config = makeConfig();

  it("4xx errors throw IronflowError with retryable=false", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, "not found"));

    const client = new BrowserKVClient(config);

    try {
      await client.getBucketInfo("missing");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IronflowError);
      const e = err as IronflowError;
      expect(e.code).toBe("HTTP_404");
      expect(e.retryable).toBe(false);
    }
  });

  it("5xx errors throw IronflowError with retryable=true", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, "internal error"));

    const client = new BrowserKVClient(config);

    try {
      await client.listBuckets();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IronflowError);
      const e = err as IronflowError;
      expect(e.code).toBe("HTTP_500");
      expect(e.retryable).toBe(true);
    }
  });

  it("extracts error message from JSON body", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, { error: "invalid bucket name" })
    );

    const client = new BrowserKVClient(config);

    try {
      await client.createBucket({ name: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as IronflowError;
      expect(e.message).toBe("invalid bucket name");
    }
  });
});

// ===========================================================================
// Environment header
// ===========================================================================

describe("environment header", () => {
  it("includes X-Ironflow-Environment on all requests", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ buckets: [], count: 0 })
    );

    const client = new BrowserKVClient(makeConfig({ environment: "staging" }));
    await client.listBuckets();

    const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
    expect(headers[HEADERS.ENVIRONMENT]).toBe("staging");
  });

  it("includes X-Ironflow-Environment on bucket handle requests", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ key: "k", value: "v", revision: 1, created_at: "", operation: "put" })
    );

    const handle = new BrowserKVBucketHandle(
      "b",
      makeConfig({ environment: "prod" })
    );
    await handle.get("k");

    const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
    expect(headers[HEADERS.ENVIRONMENT]).toBe("prod");
  });
});

// ===========================================================================
// Auth
// ===========================================================================

describe("auth", () => {
  it("sends Bearer token when apiKey is configured", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ buckets: [], count: 0 })
    );

    const client = new BrowserKVClient(
      makeConfig({ auth: { apiKey: "sk-test-123" } })
    );
    await client.listBuckets();

    const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
  });

  it("does not send Authorization header when no apiKey", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ buckets: [], count: 0 })
    );

    const client = new BrowserKVClient(makeConfig());
    await client.listBuckets();

    const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ===========================================================================
// Watch (WebSocket)
// ===========================================================================

describe("watch", () => {
  const config = makeConfig();

  it("creates WebSocket with ws:// protocol", () => {
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate: vi.fn() });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = assertDefined(MockWebSocket.instances[0]);
    expect(ws.url).toBe(
      "ws://localhost:9123/api/v1/kv/buckets/test-bucket/watch"
    );
  });

  it("creates WebSocket with wss:// for https server", () => {
    const httpsConfig = makeConfig({ serverUrl: "https://example.com" });
    const handle = new BrowserKVBucketHandle("bucket", httpsConfig);
    handle.watch({ onUpdate: vi.fn() });

    const ws = assertDefined(MockWebSocket.instances[0]);
    expect(ws.url).toBe(
      "wss://example.com/api/v1/kv/buckets/bucket/watch"
    );
  });

  it("includes key pattern in URL", () => {
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate: vi.fn() }, { key: "user.*" });

    const ws = assertDefined(MockWebSocket.instances[0]);
    expect(ws.url).toBe(
      "ws://localhost:9123/api/v1/kv/buckets/test-bucket/watch?key=user.*"
    );
  });

  it("stop() calls ws.close()", () => {
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    const watcher = handle.watch({ onUpdate: vi.fn() });

    const ws = assertDefined(MockWebSocket.instances[0]);
    expect(ws.close).not.toHaveBeenCalled();

    watcher.stop();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it("onUpdate callback fires on kv_update message", () => {
    const onUpdate = vi.fn();
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate });

    const ws = assertDefined(MockWebSocket.instances[0]);
    const event: KVWatchEvent = {
      type: "kv_update",
      key: "user.1",
      value: "data",
      revision: 5,
      operation: "put",
      bucket: "test-bucket",
    };

    // Simulate incoming message
    ws.onmessage!(new MessageEvent("message", { data: JSON.stringify(event) }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith(event);
  });

  it("onError callback fires on WebSocket error", () => {
    const onError = vi.fn();
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate: vi.fn(), onError });

    const ws = assertDefined(MockWebSocket.instances[0]);

    // Simulate WebSocket error
    ws.onerror!(new Event("error"));

    expect(onError).toHaveBeenCalledOnce();
    const errArg = assertDefined(onError.mock.calls[0])[0] as Error;
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg.message).toBe("KV watch WebSocket error");
  });

  it("onClose callback fires when WebSocket closes", () => {
    const onClose = vi.fn();
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate: vi.fn(), onClose });

    const ws = assertDefined(MockWebSocket.instances[0]);

    // Simulate WebSocket close
    ws.onclose!();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("onError fires when message JSON parsing fails", () => {
    const onError = vi.fn();
    const handle = new BrowserKVBucketHandle("test-bucket", config);
    handle.watch({ onUpdate: vi.fn(), onError });

    const ws = assertDefined(MockWebSocket.instances[0]);

    // Simulate malformed message
    ws.onmessage!(new MessageEvent("message", { data: "not-json" }));

    expect(onError).toHaveBeenCalledOnce();
    expect(assertDefined(onError.mock.calls[0])[0]).toBeInstanceOf(Error);
  });
});
