import { describe, it, expect, vi, afterEach } from "vitest";

// Mock @ironflow/core before importing client
vi.mock("@ironflow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ironflow/core")>();
  return {
    API_ENDPOINTS: {
      TRIGGER: "/ironflow.v1.IronflowService/Trigger",
      GET_RUN: "/ironflow.v1.IronflowService/GetRun",
      LIST_RUNS: "/ironflow.v1.IronflowService/ListRuns",
      CANCEL_RUN: "/ironflow.v1.IronflowService/CancelRun",
      RETRY_RUN: "/ironflow.v1.IronflowService/RetryRun",
      REGISTER_FUNCTION: "/ironflow.v1.IronflowService/RegisterFunction",
      HEALTH: "/ironflow.v1.IronflowService/Health",
    },
    DEFAULT_SERVER_URL: "http://localhost:9123",
    getServerUrl: () => undefined,
    IronflowError: actual.IronflowError,
    UnauthenticatedError: actual.UnauthenticatedError,
    EnterpriseRequiredError: actual.EnterpriseRequiredError,
    UnauthorizedError: actual.UnauthorizedError,
  };
});

const { createClient } = await import("../client.js");

describe("onError handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should accept onError in config without error", () => {
    const client = createClient({
      onError: () => {},
    });
    expect(client).toBeDefined();
  });

  describe("request() (ConnectRPC) path", () => {
    it("should call onError with correct method, endpoint, and statusCode on HTTP error", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "Internal Server Error" }),
        })
      );

      await expect(client.emit("test.event", {})).rejects.toThrow();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "emit",
          endpoint: "/ironflow.v1.IronflowService/Trigger",
          statusCode: 500,
        })
      );
    });

    it("should call onError with statusCode undefined on network error", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("fetch failed"))
      );

      await expect(client.emit("test.event", {})).rejects.toThrow("fetch failed");

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "emit",
          endpoint: "/ironflow.v1.IronflowService/Trigger",
          statusCode: undefined,
        })
      );
    });

    it("should still throw the original error after onError fires", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ message: "Unauthorized" }),
        })
      );

      await expect(client.emit("test.event", {})).rejects.toThrow("Unauthorized");
      expect(onError).toHaveBeenCalledOnce();
    });

    it("should await async onError before re-throwing", async () => {
      const order: string[] = [];
      const onError = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("onError");
      });
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "fail" }),
        })
      );

      try {
        await client.emit("test.event", {});
      } catch {
        order.push("catch");
      }

      expect(order).toEqual(["onError", "catch"]);
    });

    it("should swallow onError callback errors and still throw the original", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const onError = vi.fn(() => {
        throw new Error("callback boom");
      });
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "server error" }),
        })
      );

      await expect(client.emit("test.event", {})).rejects.toThrow("server error");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ironflow] onError callback threw:",
        expect.any(Error)
      );
      consoleErrorSpy.mockRestore();
    });
  });

  describe("namespaced method names", () => {
    it("should use dot-notation method name for streams.append", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "stream error" }),
        })
      );

      await expect(
        client.streams.append("entity-1", { name: "test.event", data: {}, entityType: "order" })
      ).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "streams.append",
          endpoint: "/ironflow.v1.EntityStreamService/AppendEvent",
          statusCode: 500,
        })
      );
    });
  });

  describe("restRequest() (REST) path", () => {
    it("should call onError with correct context on REST error", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({ error: "Not Found" }),
        })
      );

      await expect(client.apiKeys.get("ak_123")).rejects.toThrow();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "apiKeys.get",
          endpoint: "/api/v1/apikeys/ak_123",
          statusCode: 404,
        })
      );
    });
  });

  describe("raw fetch methods", () => {
    it("should call onError for patchStep errors", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => "patch failed",
        })
      );

      await expect(client.patchStep("step_1", { value: 1 })).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "patchStep",
          endpoint: "/api/v1/steps/patch",
          statusCode: 500,
        })
      );
    });

    it("should call onError for resumeRun errors", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: async () => "run not found",
        })
      );

      await expect(client.resumeRun("run_1")).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "resumeRun",
          endpoint: "/api/v1/runs/resume",
          statusCode: 404,
        })
      );
    });

    it("should call onError for listFunctions errors", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => "unavailable",
        })
      );

      await expect(client.listFunctions()).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "listFunctions",
          endpoint: "/api/v1/functions",
          statusCode: 503,
        })
      );
    });

    it("should call onError for listWorkers errors", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => "unavailable",
        })
      );

      await expect(client.listWorkers()).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "listWorkers",
          endpoint: "/api/v1/workers",
          statusCode: 503,
        })
      );
    });

    it("should call onError for network errors with undefined statusCode", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("fetch failed"))
      );

      await expect(client.listFunctions()).rejects.toThrow("fetch failed");

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "listFunctions",
          endpoint: "/api/v1/functions",
          statusCode: undefined,
        })
      );
    });
  });

  describe("sub-client propagation", () => {
    it("should propagate onError to KVClient", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: "KV error" }),
        })
      );

      const kv = client.kv();
      await expect(kv.listBuckets()).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "kv.listBuckets",
          endpoint: "/api/v1/kv/buckets",
        })
      );
    });

    it("should propagate onError to KVBucketHandle", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ error: "key not found" }),
        })
      );

      const handle = client.kv().bucket("test-bucket");
      await expect(handle.get("missing-key")).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "kv.bucket.get",
          endpoint: expect.stringContaining("/api/v1/kv/buckets/test-bucket/keys/missing-key"),
        })
      );
    });

    it("should propagate onError to ConfigClient", async () => {
      const onError = vi.fn();
      const client = createClient({ onError });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: "config error" }),
        })
      );

      const config = client.config();
      await expect(config.get("app")).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "config.get",
          endpoint: "/api/v1/config/app",
        })
      );
    });
  });

  describe("no onError configured", () => {
    it("should throw errors normally when onError is not set", async () => {
      const client = createClient();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "fail" }),
        })
      );

      await expect(client.emit("test.event", {})).rejects.toThrow("fail");
    });
  });
});
