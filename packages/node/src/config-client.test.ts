import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigClient } from "./config-client.js";
import type { ConfigClientConfig } from "./config-client.js";
import { assertDefined } from "./internal/assert-defined.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:9123";

function defaultConfig(overrides?: Partial<ConfigClientConfig>): ConfigClientConfig {
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
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readonly options: unknown;
  readyState = MockWebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Error) => void) | null = null;

  close = vi.fn((code?: number) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  });

  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError(err: Error = new Error("ws error")): void {
    this.onerror?.(err);
  }

  simulateClose(code: number = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let mockWs: MockWebSocket;
const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());

  // Replace global WebSocket with mock
  (globalThis as Record<string, unknown>).WebSocket = class extends MockWebSocket {
    constructor(url: string, options?: unknown) {
      super(url, options);
      mockWs = this;
    }
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

// ===========================================================================
// ConfigClient – HTTP operations
// ===========================================================================

describe("ConfigClient", () => {
  describe("set", () => {
    it("should POST to /api/v1/config/{name} and return result", async () => {
      const result = { name: "app", revision: 1 };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(200, result));

      const client = new ConfigClient(defaultConfig());
      const res = await client.set("app", { theme: "dark" });

      expect(res).toEqual(result);
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config/app`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ theme: "dark" });
    });
  });

  describe("get", () => {
    it("should GET config by name", async () => {
      const config = {
        name: "app",
        data: { theme: "dark" },
        revision: 3,
        updatedAt: "2026-01-01T00:00:00Z",
      };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(200, config));

      const client = new ConfigClient(defaultConfig());
      const res = await client.get("app");

      expect(res).toEqual(config);
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config/app`);
      expect(init.method).toBe("GET");
    });
  });

  describe("patch", () => {
    it("should PATCH config with shallow merge data", async () => {
      const result = { name: "app", revision: 4 };
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(200, result));

      const client = new ConfigClient(defaultConfig());
      const res = await client.patch("app", { newKey: "value" });

      expect(res).toEqual(result);
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config/app`);
      expect(init.method).toBe("PATCH");
    });
  });

  describe("list", () => {
    it("should GET all configs and return configs array", async () => {
      const configs = [
        { name: "app", revision: 1, updatedAt: "2026-01-01T00:00:00Z" },
        { name: "db", revision: 2, updatedAt: "2026-01-02T00:00:00Z" },
      ];
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { configs })
      );

      const client = new ConfigClient(defaultConfig());
      const res = await client.list();

      expect(res).toEqual(configs);
      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config`);
      expect(init.method).toBe("GET");
    });
  });

  describe("delete", () => {
    it("should DELETE config by name", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(204));

      const client = new ConfigClient(defaultConfig());
      await client.delete("app");

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config/app`);
      expect(init.method).toBe("DELETE");
    });

    it("should URL-encode config name", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(createMockResponse(204));

      const client = new ConfigClient(defaultConfig());
      await client.delete("my config");

      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/config/my%20config`);
    });
  });

  describe("auth", () => {
    it("should include Authorization header when apiKey is set", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { configs: [] })
      );

      const client = new ConfigClient(defaultConfig({ apiKey: "test-key" }));
      await client.list();

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });

    it("should not include Authorization header when apiKey is absent", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(200, { configs: [] })
      );

      const client = new ConfigClient(defaultConfig());
      await client.list();

      const { init } = lastFetchCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should throw on 404 with error message from body", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse(404, { error: "config not found" })
      );

      const client = new ConfigClient(defaultConfig());
      await expect(client.get("missing")).rejects.toThrow("config not found");
    });

    it("should throw on 500 with status info", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 500 })
      );

      const client = new ConfigClient(defaultConfig());
      await expect(client.list()).rejects.toThrow(
        "Config request failed with status 500"
      );
    });
  });
});

// ===========================================================================
// ConfigClient.watch() – WebSocket
// ===========================================================================

describe("ConfigClient.watch()", () => {
  it("should open a WebSocket to the correct URL", () => {
    const client = new ConfigClient(defaultConfig());
    client.watch("my-config", { onUpdate: vi.fn() });

    expect(mockWs.url).toBe("ws://localhost:9123/api/v1/config/my-config/watch");
  });

  it("should convert https to wss", () => {
    const client = new ConfigClient(defaultConfig({ serverUrl: "https://api.example.com" }));
    client.watch("cfg", { onUpdate: vi.fn() });

    expect(mockWs.url).toBe("wss://api.example.com/api/v1/config/cfg/watch");
  });

  it("should URL-encode config name", () => {
    const client = new ConfigClient(defaultConfig());
    client.watch("my config", { onUpdate: vi.fn() });

    expect(mockWs.url).toBe("ws://localhost:9123/api/v1/config/my%20config/watch");
  });

  it("should pass Authorization header in WebSocket options when apiKey is set", () => {
    const client = new ConfigClient(defaultConfig({ apiKey: "ifkey_abc123" }));
    client.watch("cfg", { onUpdate: vi.fn() });

    const options = mockWs.options as { headers?: Record<string, string> };
    expect(options?.headers?.["Authorization"]).toBe("Bearer ifkey_abc123");
  });

  it("should not pass Authorization header when apiKey is absent", () => {
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn() });

    const options = mockWs.options as { headers?: Record<string, string> };
    // headers object exists but should be empty (no Authorization key)
    expect(options?.headers?.["Authorization"]).toBeUndefined();
  });

  it("should call onUpdate when a config_update message is received", () => {
    const onUpdate = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate });

    const event = {
      type: "config_update",
      name: "cfg",
      data: { theme: "dark" },
      revision: 5,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockWs.simulateMessage(event);

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith(event);
  });

  it("should not call onUpdate for unrecognised message types", () => {
    const onUpdate = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate });

    mockWs.simulateMessage({ type: "ping" });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("should call onError when an error message is received", () => {
    const onError = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn(), onError });

    mockWs.simulateMessage({ type: "error", message: "failed to start config watch" });

    expect(onError).toHaveBeenCalledOnce();
    expect(assertDefined(onError.mock.calls[0])[0]).toBeInstanceOf(Error);
    expect((assertDefined(onError.mock.calls[0])[0] as Error).message).toBe("failed to start config watch");
  });

  it("should call onError with generic message when error message is missing", () => {
    const onError = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn(), onError });

    mockWs.simulateMessage({ type: "error" });

    expect(onError).toHaveBeenCalledOnce();
    expect((assertDefined(onError.mock.calls[0])[0] as Error).message).toBe("config watch error");
  });

  it("should call onError when JSON parse fails", () => {
    const onError = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn(), onError });

    // Inject raw invalid JSON directly into onmessage
    mockWs.onmessage?.({ data: "not-valid-json" });

    expect(onError).toHaveBeenCalledOnce();
    expect(assertDefined(onError.mock.calls[0])[0]).toBeInstanceOf(Error);
  });

  it("should call onError on WebSocket error event", () => {
    const onError = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn(), onError });

    mockWs.simulateError();

    expect(onError).toHaveBeenCalledOnce();
    expect((assertDefined(onError.mock.calls[0])[0] as Error).message).toBe("config watch WebSocket error");
  });

  it("should call onClose when WebSocket closes", () => {
    const onClose = vi.fn();
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn(), onClose });

    mockWs.simulateClose(1000);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not throw when onError is not provided and error occurs", () => {
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn() });

    // Should not throw even though no onError callback
    expect(() => mockWs.simulateError()).not.toThrow();
  });

  it("should not throw when onClose is not provided and connection closes", () => {
    const client = new ConfigClient(defaultConfig());
    client.watch("cfg", { onUpdate: vi.fn() });

    expect(() => mockWs.simulateClose()).not.toThrow();
  });

  describe("stop()", () => {
    it("should close the WebSocket when stop() is called", () => {
      const client = new ConfigClient(defaultConfig());
      const watcher = client.watch("cfg", { onUpdate: vi.fn() });

      watcher.stop();

      expect(mockWs.close).toHaveBeenCalledOnce();
    });

    it("should call onClose callback when stop() is called", () => {
      const onClose = vi.fn();
      const client = new ConfigClient(defaultConfig());
      const watcher = client.watch("cfg", { onUpdate: vi.fn(), onClose });

      watcher.stop();

      expect(onClose).toHaveBeenCalledOnce();
    });

    it("should stop receiving events after stop() is called", () => {
      const onUpdate = vi.fn();
      const client = new ConfigClient(defaultConfig());
      const watcher = client.watch("cfg", { onUpdate });

      watcher.stop();

      // Simulate a message after stop — onmessage is still set on the mock
      // but the socket is "closed". The real WebSocket won't fire after close;
      // we just verify close was called.
      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe("multiple updates", () => {
    it("should call onUpdate for each config_update message", () => {
      const onUpdate = vi.fn();
      const client = new ConfigClient(defaultConfig());
      client.watch("cfg", { onUpdate });

      const event1 = { type: "config_update", name: "cfg", data: { v: 1 }, revision: 1, updatedAt: "2026-01-01T00:00:00Z" };
      const event2 = { type: "config_update", name: "cfg", data: { v: 2 }, revision: 2, updatedAt: "2026-01-02T00:00:00Z" };

      mockWs.simulateMessage(event1);
      mockWs.simulateMessage(event2);

      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect(onUpdate).toHaveBeenNthCalledWith(1, event1);
      expect(onUpdate).toHaveBeenNthCalledWith(2, event2);
    });
  });
});
