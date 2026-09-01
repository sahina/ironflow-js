import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { assertDefined } from "./internal/assert-defined.js";

// Inline mergeConfig logic to avoid triggering @ironflow/core imports
const DEFAULT_CONFIG = {
  serverUrl: "http://localhost:9123",
  transport: "connectrpc" as const,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    backoff: { initial: 1000, max: 30000, multiplier: 2 },
  },
  visibility: { pauseOnHidden: true, reconnectOnVisible: true },
};

type ConfigOptions = {
  serverUrl?: string;
  transport?: "connectrpc" | "websocket";
  reconnect?: boolean | { enabled?: boolean; maxAttempts?: number; backoff?: { initial?: number; max?: number; multiplier?: number } };
  visibility?: { pauseOnHidden?: boolean; reconnectOnVisible?: boolean };
};

function mergeConfig(options: ConfigOptions) {
  const reconnect =
    typeof options.reconnect === "boolean"
      ? { ...DEFAULT_CONFIG.reconnect, enabled: options.reconnect }
      : {
          enabled: options.reconnect?.enabled ?? DEFAULT_CONFIG.reconnect.enabled,
          maxAttempts: options.reconnect?.maxAttempts ?? DEFAULT_CONFIG.reconnect.maxAttempts,
          backoff: {
            initial: options.reconnect?.backoff?.initial ?? DEFAULT_CONFIG.reconnect.backoff.initial,
            max: options.reconnect?.backoff?.max ?? DEFAULT_CONFIG.reconnect.backoff.max,
            multiplier: options.reconnect?.backoff?.multiplier ?? DEFAULT_CONFIG.reconnect.backoff.multiplier,
          },
        };
  return {
    serverUrl: options.serverUrl ?? DEFAULT_CONFIG.serverUrl,
    transport: options.transport ?? DEFAULT_CONFIG.transport,
    reconnect,
    visibility: {
      pauseOnHidden: options.visibility?.pauseOnHidden ?? DEFAULT_CONFIG.visibility.pauseOnHidden,
      reconnectOnVisible: options.visibility?.reconnectOnVisible ?? DEFAULT_CONFIG.visibility.reconnectOnVisible,
    },
  };
}

// Test pattern generation logic inline to avoid triggering core imports
const patterns = {
  run: (runId: string) => `system.run.${runId}.*`,
  step: (runId: string, stepId: string) => `system.run.${runId}.step.${stepId}`,
  event: (pattern: string) => `events:${pattern}`,
};

describe("patterns", () => {
  it("should generate run pattern", () => {
    const pattern = patterns.run("run-123");
    expect(pattern).toBe("system.run.run-123.*");
  });

  it("should generate step pattern", () => {
    const pattern = patterns.step("run-123", "step-1");
    expect(pattern).toBe("system.run.run-123.step.step-1");
  });

  it("should generate event pattern", () => {
    const pattern = patterns.event("order.*");
    expect(pattern).toBe("events:order.*");
  });

  it("should generate all events pattern", () => {
    const pattern = patterns.event("*");
    expect(pattern).toBe("events:*");
  });
});

describe("client configuration logic", () => {
  it("should default to connectrpc transport", () => {
    const config = mergeConfig({});
    expect(config.transport).toBe("connectrpc");
  });

  it("should use websocket transport when specified", () => {
    const config = mergeConfig({ transport: "websocket" });
    expect(config.transport).toBe("websocket");
  });

  it("should use default server URL", () => {
    const config = mergeConfig({});
    expect(config.serverUrl).toBe("http://localhost:9123");
  });

  it("should use custom server URL", () => {
    const config = mergeConfig({ serverUrl: "https://custom.example.com" });
    expect(config.serverUrl).toBe("https://custom.example.com");
  });

  it("should enable reconnect by default", () => {
    const config = mergeConfig({});
    expect(config.reconnect.enabled).toBe(true);
  });

  it("should allow disabling reconnect", () => {
    const config = mergeConfig({ reconnect: false });
    expect(config.reconnect.enabled).toBe(false);
  });
});

describe("detectTransport mock behavior", () => {
  it("should return websocket when fetch fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    // Simulate detectTransport logic
    async function detectTransport(serverUrl: string): Promise<"connectrpc" | "websocket"> {
      try {
        const response = await fetch(
          `${serverUrl}/ironflow.v1.IronflowService/GetCapabilities`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        );
        if (response.ok) {
          return "connectrpc";
        }
      } catch {
        // ConnectRPC not available
      }
      return "websocket";
    }

    const transport = await detectTransport("http://localhost:9123");
    expect(transport).toBe("websocket");

    global.fetch = originalFetch;
  });

  it("should return connectrpc when fetch succeeds", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    async function detectTransport(serverUrl: string): Promise<"connectrpc" | "websocket"> {
      try {
        const response = await fetch(
          `${serverUrl}/ironflow.v1.IronflowService/GetCapabilities`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        );
        if (response.ok) {
          return "connectrpc";
        }
      } catch {
        // ConnectRPC not available
      }
      return "websocket";
    }

    const transport = await detectTransport("http://localhost:9123");
    expect(transport).toBe("connectrpc");

    global.fetch = originalFetch;
  });
});

describe("patchStep behavior", () => {
  it("should POST to /api/v1/steps/patch with correct body", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    const serverUrl = "http://localhost:9123";
    const stepId = "step-abc";
    const output = { result: "fixed" };
    const reason = "manual correction";

    async function patchStep(
      serverUrl: string,
      stepId: string,
      output: Record<string, unknown>,
      reason?: string
    ): Promise<void> {
      const url = `${serverUrl}/api/v1/steps/patch`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_id: stepId, output, reason: reason || "" }),
      });
      if (!response.ok) {
        throw new Error(`Patch step failed: ${response.status}`);
      }
    }

    await patchStep(serverUrl, stepId, output, reason);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    const opts = assertDefined(options);
    expect(url).toBe("http://localhost:9123/api/v1/steps/patch");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body as string);
    expect(body.step_id).toBe("step-abc");
    expect(body.output).toEqual({ result: "fixed" });
    expect(body.reason).toBe("manual correction");

    global.fetch = originalFetch;
  });

  it("should default reason to empty string when not provided", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    async function patchStep(
      serverUrl: string,
      stepId: string,
      output: Record<string, unknown>,
      reason?: string
    ): Promise<void> {
      const url = `${serverUrl}/api/v1/steps/patch`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_id: stepId, output, reason: reason || "" }),
      });
      if (!response.ok) {
        throw new Error(`Patch step failed: ${response.status}`);
      }
    }

    await patchStep("http://localhost:9123", "step-1", { val: 1 });

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.reason).toBe("");

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"step not found"}'),
    });

    async function patchStep(
      serverUrl: string,
      stepId: string,
      output: Record<string, unknown>,
      reason?: string
    ): Promise<void> {
      const url = `${serverUrl}/api/v1/steps/patch`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_id: stepId, output, reason: reason || "" }),
      });
      if (!response.ok) {
        throw new Error(`Patch step failed: ${response.status}`);
      }
    }

    await expect(
      patchStep("http://localhost:9123", "step-missing", { x: 1 })
    ).rejects.toThrow("Patch step failed: 404");

    global.fetch = originalFetch;
  });
});

describe("listFunctions behavior", () => {
  it("should GET /api/v1/functions and return functions array", async () => {
    const originalFetch = global.fetch;
    const mockFunctions = [
      { id: "fn-1", name: "process-order" },
      { id: "fn-2", name: "send-email" },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ functions: mockFunctions }),
    });
    global.fetch = mockFetch;

    async function listFunctions(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/functions`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List functions failed: ${response.status}`);
      }
      const data = await response.json();
      return data.functions || [];
    }

    const result = await listFunctions("http://localhost:9123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/api/v1/functions");
    expect(assertDefined(options).method).toBe("GET");
    expect(result).toEqual(mockFunctions);

    global.fetch = originalFetch;
  });

  it("should return empty array when functions field is missing", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    async function listFunctions(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/functions`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List functions failed: ${response.status}`);
      }
      const data = await response.json();
      return data.functions || [];
    }

    const result = await listFunctions("http://localhost:9123");
    expect(result).toEqual([]);

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    async function listFunctions(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/functions`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List functions failed: ${response.status}`);
      }
      const data = await response.json();
      return data.functions || [];
    }

    await expect(
      listFunctions("http://localhost:9123")
    ).rejects.toThrow("List functions failed: 503");

    global.fetch = originalFetch;
  });
});

describe("listWorkers behavior", () => {
  it("should GET /api/v1/workers and return workers array", async () => {
    const originalFetch = global.fetch;
    const mockWorkers = [
      { id: "w-1", functionId: "fn-1", status: "active" },
      { id: "w-2", functionId: "fn-2", status: "active" },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workers: mockWorkers }),
    });
    global.fetch = mockFetch;

    async function listWorkers(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/workers`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List workers failed: ${response.status}`);
      }
      const data = await response.json();
      return data.workers || [];
    }

    const result = await listWorkers("http://localhost:9123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/api/v1/workers");
    expect(assertDefined(options).method).toBe("GET");
    expect(result).toEqual(mockWorkers);

    global.fetch = originalFetch;
  });

  it("should return empty array when workers field is missing", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    async function listWorkers(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/workers`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List workers failed: ${response.status}`);
      }
      const data = await response.json();
      return data.workers || [];
    }

    const result = await listWorkers("http://localhost:9123");
    expect(result).toEqual([]);

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    async function listWorkers(serverUrl: string): Promise<unknown[]> {
      const url = `${serverUrl}/api/v1/workers`;
      const response = await fetch(url, { method: "GET", headers: {} });
      if (!response.ok) {
        throw new Error(`List workers failed: ${response.status}`);
      }
      const data = await response.json();
      return data.workers || [];
    }

    await expect(
      listWorkers("http://localhost:9123")
    ).rejects.toThrow("List workers failed: 500");

    global.fetch = originalFetch;
  });
});

describe("health behavior", () => {
  it("should GET /health and return parsed JSON", async () => {
    const originalFetch = global.fetch;
    const mockHealth = { status: "ok", timestamp: "2026-01-01T00:00:00Z", version: "1.0.0" };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockHealth),
    });
    global.fetch = mockFetch;

    async function health(serverUrl: string): Promise<{ status: string; timestamp: string; version: string }> {
      const url = `${serverUrl}/health`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return response.json();
    }

    const result = await health("http://localhost:9123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/health");
    expect(assertDefined(options).method).toBe("GET");
    expect(result).toEqual(mockHealth);

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    async function health(serverUrl: string): Promise<unknown> {
      const url = `${serverUrl}/health`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      health("http://localhost:9123")
    ).rejects.toThrow("Health check failed: 503");

    global.fetch = originalFetch;
  });

  it("should work with custom server URL", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", timestamp: "", version: "" }),
    });
    global.fetch = mockFetch;

    async function health(serverUrl: string): Promise<unknown> {
      const url = `${serverUrl}/health`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return response.json();
    }

    await health("https://prod.example.com");

    const [url] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("https://prod.example.com/health");

    global.fetch = originalFetch;
  });
});

describe("getCapabilities behavior", () => {
  it("should GET /api/v1/capabilities and return parsed JSON", async () => {
    const originalFetch = global.fetch;
    const mockCapabilities = {
      transports: ["connectrpc", "websocket"],
      features: ["replay", "consumer-groups"],
      version: "1.0.0",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCapabilities),
    });
    global.fetch = mockFetch;

    async function getCapabilities(serverUrl: string): Promise<{ transports: string[]; features: string[]; version: string }> {
      const url = `${serverUrl}/api/v1/capabilities`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Get capabilities failed: ${response.status}`);
      }
      return response.json();
    }

    const result = await getCapabilities("http://localhost:9123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/api/v1/capabilities");
    expect(assertDefined(options).method).toBe("GET");
    expect(result).toEqual(mockCapabilities);

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    async function getCapabilities(serverUrl: string): Promise<unknown> {
      const url = `${serverUrl}/api/v1/capabilities`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Get capabilities failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      getCapabilities("http://localhost:9123")
    ).rejects.toThrow("Get capabilities failed: 500");

    global.fetch = originalFetch;
  });

  it("should work with custom server URL", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ transports: [], features: [], version: "" }),
    });
    global.fetch = mockFetch;

    async function getCapabilities(serverUrl: string): Promise<unknown> {
      const url = `${serverUrl}/api/v1/capabilities`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Get capabilities failed: ${response.status}`);
      }
      return response.json();
    }

    await getCapabilities("https://staging.example.com");

    const [url] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("https://staging.example.com/api/v1/capabilities");

    global.fetch = originalFetch;
  });
});

describe("emit behavior", () => {
  it("should POST to ConnectRPC Emit endpoint with correct body", async () => {
    const originalFetch = global.fetch;
    const mockResponse = { runIds: ["run-1"], eventId: "evt-1" };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });
    global.fetch = mockFetch;

    type EmitOptions = {
      version?: number;
      idempotencyKey?: string;
      metadata?: Record<string, string>;
      namespace?: string;
    };

    async function emit(
      serverUrl: string,
      eventName: string,
      data: unknown,
      options?: EmitOptions
    ): Promise<{ runIds: string[]; eventId: string }> {
      const url = `${serverUrl}/ironflow.v1.PubSubService/Emit`;
      const body: Record<string, unknown> = {
        event: eventName,
        data,
        ...(options?.version ? { version: options.version } : {}),
        idempotency_key: options?.idempotencyKey,
        metadata: options?.metadata,
        namespace: options?.namespace,
      };
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Emit failed: ${response.status}`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      return { runIds: parsed.runIds ?? [], eventId: parsed.eventId };
    }

    const result = await emit("http://localhost:9123", "order.created", { orderId: "123" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/ironflow.v1.PubSubService/Emit");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.event).toBe("order.created");
    expect(body.data).toEqual({ orderId: "123" });
    expect(body.version).toBeUndefined();
    expect(result).toEqual(mockResponse);

    global.fetch = originalFetch;
  });

  it("should include version in body when provided in options", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ runIds: ["run-2"], eventId: "evt-2" })),
    });
    global.fetch = mockFetch;

    type EmitOptions = {
      version?: number;
      idempotencyKey?: string;
      metadata?: Record<string, string>;
      namespace?: string;
    };

    async function emit(
      serverUrl: string,
      eventName: string,
      data: unknown,
      options?: EmitOptions
    ): Promise<{ runIds: string[]; eventId: string }> {
      const url = `${serverUrl}/ironflow.v1.PubSubService/Emit`;
      const body: Record<string, unknown> = {
        event: eventName,
        data,
        ...(options?.version ? { version: options.version } : {}),
        idempotency_key: options?.idempotencyKey,
        metadata: options?.metadata,
        namespace: options?.namespace,
      };
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Emit failed: ${response.status}`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      return { runIds: parsed.runIds ?? [], eventId: parsed.eventId };
    }

    await emit("http://localhost:9123", "order.updated", { orderId: "456" }, { version: 2 });

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.version).toBe(2);
    expect(body.event).toBe("order.updated");

    global.fetch = originalFetch;
  });

  it("should not include version in body when not provided", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ runIds: [], eventId: "evt-3" })),
    });
    global.fetch = mockFetch;

    type EmitOptions = {
      version?: number;
      idempotencyKey?: string;
      metadata?: Record<string, string>;
      namespace?: string;
    };

    async function emit(
      serverUrl: string,
      eventName: string,
      data: unknown,
      options?: EmitOptions
    ): Promise<{ runIds: string[]; eventId: string }> {
      const url = `${serverUrl}/ironflow.v1.PubSubService/Emit`;
      const body: Record<string, unknown> = {
        event: eventName,
        data,
        ...(options?.version ? { version: options.version } : {}),
        idempotency_key: options?.idempotencyKey,
        metadata: options?.metadata,
        namespace: options?.namespace,
      };
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Emit failed: ${response.status}`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      return { runIds: parsed.runIds ?? [], eventId: parsed.eventId };
    }

    await emit("http://localhost:9123", "order.deleted", {}, { idempotencyKey: "key-1" });

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.version).toBeUndefined();
    expect(body.idempotency_key).toBe("key-1");

    global.fetch = originalFetch;
  });
});

describe("streams.append behavior", () => {
  it("should POST to /ironflow.v1.EntityStreamService/AppendEvent with correct body", async () => {
    const originalFetch = global.fetch;
    const mockResponse = { entityVersion: 1, eventId: "evt-abc" };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    global.fetch = mockFetch;

    async function appendEvent(
      serverUrl: string,
      entityId: string,
      input: { name: string; data: Record<string, unknown>; entityType: string },
      options?: { expectedVersion?: number; idempotencyKey?: string; version?: number }
    ): Promise<{ entityVersion: number; eventId: string }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/AppendEvent`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          entity_type: input.entityType,
          event_name: input.name,
          data: input.data,
          expected_version: options?.expectedVersion ?? -1,
          idempotency_key: options?.idempotencyKey ?? "",
          version: options?.version ?? 1,
        }),
      });
      if (!response.ok) {
        throw new Error(`Append event failed: ${response.status}`);
      }
      const data = await response.json();
      return { entityVersion: data.entityVersion, eventId: data.eventId };
    }

    const result = await appendEvent(
      "http://localhost:9123",
      "order-123",
      { name: "order.created", data: { total: 100 }, entityType: "order" }
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/ironflow.v1.EntityStreamService/AppendEvent");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(options.body);
    expect(body.entity_id).toBe("order-123");
    expect(body.entity_type).toBe("order");
    expect(body.event_name).toBe("order.created");
    expect(body.data).toEqual({ total: 100 });
    expect(body.expected_version).toBe(-1);
    expect(body.idempotency_key).toBe("");
    expect(body.version).toBe(1);
    expect(result).toEqual({ entityVersion: 1, eventId: "evt-abc" });

    global.fetch = originalFetch;
  });

  it("should pass options when provided", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ entityVersion: 2, eventId: "evt-def" }),
    });
    global.fetch = mockFetch;

    async function appendEvent(
      serverUrl: string,
      entityId: string,
      input: { name: string; data: Record<string, unknown>; entityType: string },
      options?: { expectedVersion?: number; idempotencyKey?: string; version?: number }
    ): Promise<{ entityVersion: number; eventId: string }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/AppendEvent`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          entity_type: input.entityType,
          event_name: input.name,
          data: input.data,
          expected_version: options?.expectedVersion ?? -1,
          idempotency_key: options?.idempotencyKey ?? "",
          version: options?.version ?? 1,
        }),
      });
      if (!response.ok) {
        throw new Error(`Append event failed: ${response.status}`);
      }
      const data = await response.json();
      return { entityVersion: data.entityVersion, eventId: data.eventId };
    }

    const result = await appendEvent(
      "http://localhost:9123",
      "order-456",
      { name: "order.updated", data: { status: "shipped" }, entityType: "order" },
      { expectedVersion: 1, idempotencyKey: "idem-key-1", version: 2 }
    );

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.expected_version).toBe(1);
    expect(body.idempotency_key).toBe("idem-key-1");
    expect(body.version).toBe(2);
    expect(result).toEqual({ entityVersion: 2, eventId: "evt-def" });

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve('{"message":"version conflict"}'),
    });

    async function appendEvent(
      serverUrl: string,
      entityId: string,
      input: { name: string; data: Record<string, unknown>; entityType: string }
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/AppendEvent`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          entity_type: input.entityType,
          event_name: input.name,
          data: input.data,
          expected_version: -1,
          idempotency_key: "",
          version: 1,
        }),
      });
      if (!response.ok) {
        throw new Error(`Append event failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      appendEvent("http://localhost:9123", "order-789", {
        name: "order.created",
        data: {},
        entityType: "order",
      })
    ).rejects.toThrow("Append event failed: 409");

    global.fetch = originalFetch;
  });
});

describe("streams.read behavior", () => {
  it("should POST to /ironflow.v1.EntityStreamService/ReadStream with correct body", async () => {
    const originalFetch = global.fetch;
    const mockEvents = [
      {
        id: "evt-1",
        name: "order.created",
        data: { total: 100 },
        entityVersion: 1,
        version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        source: "api",
        metadata: { user: "admin" },
      },
      {
        id: "evt-2",
        name: "order.updated",
        data: { status: "shipped" },
        entityVersion: 2,
        version: 1,
        timestamp: "2026-01-01T01:00:00Z",
      },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: mockEvents, totalCount: 2 }),
    });
    global.fetch = mockFetch;

    type ReadStreamOptions = {
      fromVersion?: number;
      limit?: number;
      direction?: "forward" | "backward";
    };

    async function readStream(
      serverUrl: string,
      entityId: string,
      options?: ReadStreamOptions
    ): Promise<{ events: unknown[]; totalCount: number }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/ReadStream`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          from_version: options?.fromVersion ?? 0,
          limit: options?.limit ?? 0,
          direction: options?.direction ?? "forward",
        }),
      });
      if (!response.ok) {
        throw new Error(`Read stream failed: ${response.status}`);
      }
      const data = await response.json();
      return {
        events: (data.events ?? []).map((e: Record<string, unknown>) => ({
          id: e.id,
          name: e.name,
          data: e.data ?? {},
          entityVersion: e.entityVersion,
          version: e.version,
          timestamp: e.timestamp,
          source: e.source,
          metadata: e.metadata,
        })),
        totalCount: data.totalCount ?? 0,
      };
    }

    const result = await readStream("http://localhost:9123", "order-123", { limit: 10 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/ironflow.v1.EntityStreamService/ReadStream");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(options.body);
    expect(body.entity_id).toBe("order-123");
    expect(body.from_version).toBe(0);
    expect(body.limit).toBe(10);
    expect(body.direction).toBe("forward");

    expect(result.totalCount).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual({
      id: "evt-1",
      name: "order.created",
      data: { total: 100 },
      entityVersion: 1,
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      source: "api",
      metadata: { user: "admin" },
    });
    expect(result.events[1]).toEqual({
      id: "evt-2",
      name: "order.updated",
      data: { status: "shipped" },
      entityVersion: 2,
      version: 1,
      timestamp: "2026-01-01T01:00:00Z",
      source: undefined,
      metadata: undefined,
    });

    global.fetch = originalFetch;
  });

  it("should use options when provided", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [], totalCount: 0 }),
    });
    global.fetch = mockFetch;

    async function readStream(
      serverUrl: string,
      entityId: string,
      options?: { fromVersion?: number; limit?: number; direction?: "forward" | "backward" }
    ): Promise<{ events: unknown[]; totalCount: number }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/ReadStream`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          from_version: options?.fromVersion ?? 0,
          limit: options?.limit ?? 0,
          direction: options?.direction ?? "forward",
        }),
      });
      if (!response.ok) {
        throw new Error(`Read stream failed: ${response.status}`);
      }
      const data = await response.json();
      return {
        events: (data.events ?? []).map((e: Record<string, unknown>) => ({
          id: e.id,
          name: e.name,
          data: e.data ?? {},
          entityVersion: e.entityVersion,
          version: e.version,
          timestamp: e.timestamp,
          source: e.source,
          metadata: e.metadata,
        })),
        totalCount: data.totalCount ?? 0,
      };
    }

    await readStream("http://localhost:9123", "user-456", {
      fromVersion: 5,
      limit: 20,
      direction: "backward",
    });

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.entity_id).toBe("user-456");
    expect(body.from_version).toBe(5);
    expect(body.limit).toBe(20);
    expect(body.direction).toBe("backward");

    global.fetch = originalFetch;
  });

  it("should return empty events array when events field is missing", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    async function readStream(
      serverUrl: string,
      entityId: string
    ): Promise<{ events: unknown[]; totalCount: number }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/ReadStream`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          from_version: 0,
          limit: 0,
          direction: "forward",
        }),
      });
      if (!response.ok) {
        throw new Error(`Read stream failed: ${response.status}`);
      }
      const data = await response.json();
      return {
        events: (data.events ?? []).map((e: Record<string, unknown>) => ({
          id: e.id,
          name: e.name,
          data: e.data ?? {},
          entityVersion: e.entityVersion,
          version: e.version,
          timestamp: e.timestamp,
          source: e.source,
          metadata: e.metadata,
        })),
        totalCount: data.totalCount ?? 0,
      };
    }

    const result = await readStream("http://localhost:9123", "order-empty");
    expect(result.events).toEqual([]);
    expect(result.totalCount).toBe(0);

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"stream not found"}'),
    });

    async function readStream(
      serverUrl: string,
      entityId: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/ReadStream`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          from_version: 0,
          limit: 0,
          direction: "forward",
        }),
      });
      if (!response.ok) {
        throw new Error(`Read stream failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      readStream("http://localhost:9123", "nonexistent")
    ).rejects.toThrow("Read stream failed: 404");

    global.fetch = originalFetch;
  });
});

describe("streams.getInfo behavior", () => {
  it("should POST to /ironflow.v1.EntityStreamService/GetStreamInfo with correct body", async () => {
    const originalFetch = global.fetch;
    const mockResponse = {
      entityId: "order-123",
      entityType: "order",
      version: 5,
      eventCount: 5,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-15T12:00:00Z",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    global.fetch = mockFetch;

    async function getStreamInfo(
      serverUrl: string,
      entityId: string
    ): Promise<{
      entityId: string;
      entityType: string;
      version: number;
      eventCount: number;
      createdAt: string;
      updatedAt: string;
    }> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/GetStreamInfo`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId }),
      });
      if (!response.ok) {
        throw new Error(`Get stream info failed: ${response.status}`);
      }
      const data = await response.json();
      return {
        entityId: data.entityId,
        entityType: data.entityType,
        version: data.version,
        eventCount: data.eventCount,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    }

    const result = await getStreamInfo("http://localhost:9123", "order-123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/ironflow.v1.EntityStreamService/GetStreamInfo");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(options.body);
    expect(body.entity_id).toBe("order-123");

    expect(result).toEqual({
      entityId: "order-123",
      entityType: "order",
      version: 5,
      eventCount: 5,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-15T12:00:00Z",
    });

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"stream not found"}'),
    });

    async function getStreamInfo(
      serverUrl: string,
      entityId: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/GetStreamInfo`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId }),
      });
      if (!response.ok) {
        throw new Error(`Get stream info failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      getStreamInfo("http://localhost:9123", "nonexistent")
    ).rejects.toThrow("Get stream info failed: 404");

    global.fetch = originalFetch;
  });

  it("should work with custom server URL", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          entityId: "user-1",
          entityType: "user",
          version: 1,
          eventCount: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
    });
    global.fetch = mockFetch;

    async function getStreamInfo(
      serverUrl: string,
      entityId: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.EntityStreamService/GetStreamInfo`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId }),
      });
      if (!response.ok) {
        throw new Error(`Get stream info failed: ${response.status}`);
      }
      return response.json();
    }

    await getStreamInfo("https://prod.example.com", "user-1");

    const [url] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("https://prod.example.com/ironflow.v1.EntityStreamService/GetStreamInfo");

    global.fetch = originalFetch;
  });
});

// ============================================================================
// Real IronflowClient tests (using imported module, not inline re-implementations)
// ============================================================================

describe("IronflowClient (real module)", () => {
  let ironflow: import("./client.js").IronflowClient;
  let IronflowClient: typeof import("./client.js").IronflowClient;

  beforeAll(async () => {
    const mod = await import("./client.js");
    ironflow = mod.ironflow;
    IronflowClient = mod.IronflowClient;
  });

  afterEach(() => {
    ironflow._resetForTesting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // Configuration & singleton
  // --------------------------------------------------------------------------

  describe("configure and isConfigured", () => {
    it("isConfigured returns false before configure", () => {
      expect(ironflow.isConfigured).toBe(false);
    });

    it("isConfigured returns true after configure", () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      expect(ironflow.isConfigured).toBe(true);
    });

    it("_resetForTesting resets isConfigured to false", () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      expect(ironflow.isConfigured).toBe(true);
      ironflow._resetForTesting();
      expect(ironflow.isConfigured).toBe(false);
    });

    it("getConfig returns config after configure", () => {
      ironflow.configure({ serverUrl: "http://test:1234", logger: false });
      const config = ironflow.getConfig();
      expect(config.serverUrl).toBe("http://test:1234");
      expect(config.transport).toBe("connectrpc");
    });

    it("getConfig throws NotConfiguredError before configure", () => {
      expect(() => ironflow.getConfig()).toThrow("Client not configured");
    });

    it("reconfiguring replaces existing config", () => {
      ironflow.configure({ serverUrl: "http://first:1111", logger: false });
      expect(ironflow.getConfig().serverUrl).toBe("http://first:1111");
      ironflow.configure({ serverUrl: "http://second:2222", logger: false });
      expect(ironflow.getConfig().serverUrl).toBe("http://second:2222");
    });

    it("connectionState returns disconnected before configure", () => {
      expect(ironflow.connectionState).toBe("disconnected");
    });

    it("new IronflowClient creates an independent instance", () => {
      const client = new IronflowClient();
      expect(client.isConfigured).toBe(false);
      client.configure({ serverUrl: "http://custom:5555", logger: false });
      expect(client.isConfigured).toBe(true);
      // singleton should still be unconfigured
      expect(ironflow.isConfigured).toBe(false);
      client._resetForTesting();
    });
  });

  // --------------------------------------------------------------------------
  // KV and config authentication
  // --------------------------------------------------------------------------

  describe("KV and config authentication", () => {
    it("uses a bearer token for KV bucket requests", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "session-token" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ buckets: [], count: 0 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.kv().listBuckets();

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer session-token");
    });

    it("uses a bearer token for KV key requests", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "session-token" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            key: "user-1",
            value: { active: true },
            revision: 1,
            created_at: "2026-08-23T00:00:00Z",
            operation: "put",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.kv().bucket("sessions").get("user-1");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer session-token");
    });

    it("uses a bearer token for config requests", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "session-token" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ configs: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.configManager().list();

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer session-token");
    });

    it("prefers the API key for KV and config requests", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "api-key", token: "session-token" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            buckets: [],
            configs: [],
            key: "user-1",
            value: { active: true },
            revision: 1,
            created_at: "2026-08-23T00:00:00Z",
            operation: "put",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.kv().listBuckets();
      await ironflow.kv().bucket("sessions").get("user-1");
      await ironflow.configManager().list();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      for (const call of mockFetch.mock.calls) {
        const headers = assertDefined(call[1]).headers;
        expect(headers["Authorization"]).toBe("Bearer api-key");
      }
    });

    it("falls back to the token when the API key is empty", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "", token: "session-token" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            buckets: [],
            configs: [],
            key: "user-1",
            value: { active: true },
            revision: 1,
            created_at: "2026-08-23T00:00:00Z",
            operation: "put",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.kv().listBuckets();
      await ironflow.kv().bucket("sessions").get("user-1");
      await ironflow.configManager().list();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      for (const call of mockFetch.mock.calls) {
        const headers = assertDefined(call[1]).headers;
        expect(headers["Authorization"]).toBe("Bearer session-token");
      }
    });
  });

  // --------------------------------------------------------------------------
  // ensureConfigured (tested via public methods before configure)
  // --------------------------------------------------------------------------

  describe("ensureConfigured (not-configured errors)", () => {
    it("invoke throws NotConfiguredError", async () => {
      await expect(ironflow.invoke("fn-1", { data: {} })).rejects.toThrow(
        "Client not configured"
      );
    });

    it("getRun throws NotConfiguredError", async () => {
      await expect(ironflow.getRun("run-1")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("listRuns throws NotConfiguredError", async () => {
      await expect(ironflow.listRuns()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("cancelRun throws NotConfiguredError", async () => {
      await expect(ironflow.cancelRun("run-1")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("emit throws NotConfiguredError", async () => {
      await expect(ironflow.emit("event.name", {})).rejects.toThrow(
        "Client not configured"
      );
    });

    it("patchStep throws NotConfiguredError", async () => {
      await expect(ironflow.patchStep("step-1", {})).rejects.toThrow(
        "Client not configured"
      );
    });

    it("resumeRun throws NotConfiguredError", async () => {
      await expect(ironflow.resumeRun("run-1")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("listFunctions throws NotConfiguredError", async () => {
      await expect(ironflow.listFunctions()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("listWorkers throws NotConfiguredError", async () => {
      await expect(ironflow.listWorkers()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("health throws NotConfiguredError", async () => {
      await expect(ironflow.health()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("getCapabilities throws NotConfiguredError", async () => {
      await expect(ironflow.getCapabilities()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("connect throws NotConfiguredError", async () => {
      await expect(ironflow.connect()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("onConnectionChange throws NotConfiguredError", () => {
      expect(() => ironflow.onConnectionChange(() => {})).toThrow(
        "Client not configured"
      );
    });

    it("subscribe throws NotConfiguredError", () => {
      // subscribe calls ensureConfigured() synchronously before returning Promise
      expect(() =>
        ironflow.subscribe("system.run.*", { onEvent: () => {} })
      ).toThrow("Client not configured");
    });

    it("subscriptionGroup throws NotConfiguredError", () => {
      expect(() => ironflow.subscriptionGroup()).toThrow(
        "Client not configured"
      );
    });

    it("onError throws NotConfiguredError", () => {
      expect(() => ironflow.onError(() => {})).toThrow(
        "Client not configured"
      );
    });

    it("streams.append throws NotConfiguredError", async () => {
      await expect(
        ironflow.streams.append("entity-1", {
          name: "evt",
          data: {},
          entityType: "test",
        })
      ).rejects.toThrow("Client not configured");
    });

    it("streams.read throws NotConfiguredError", async () => {
      await expect(ironflow.streams.read("entity-1")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("streams.getInfo throws NotConfiguredError", async () => {
      await expect(ironflow.streams.getInfo("entity-1")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("streams.subscribe throws NotConfiguredError", async () => {
      await expect(
        ironflow.streams.subscribe("entity-1", {
          entityType: "order",
          onEvent: () => {},
        })
      ).rejects.toThrow("Client not configured");
    });

    it("getProjection throws NotConfiguredError", async () => {
      await expect(ironflow.getProjection("order-stats")).rejects.toThrow(
        "Client not configured"
      );
    });

    it("getProjectionStatus throws NotConfiguredError", async () => {
      await expect(
        ironflow.getProjectionStatus("order-stats")
      ).rejects.toThrow("Client not configured");
    });

    it("publish throws NotConfiguredError", async () => {
      await expect(
        ironflow.publish("notifications", { message: "hello" })
      ).rejects.toThrow("Client not configured");
    });

    it("listProjections throws NotConfiguredError", async () => {
      await expect(ironflow.listProjections()).rejects.toThrow(
        "Client not configured"
      );
    });

    it("subscribeToProjection throws NotConfiguredError", async () => {
      await expect(
        ironflow.subscribeToProjection("order-stats", {
          onUpdate: () => {},
        })
      ).rejects.toThrow("Client not configured");
    });
  });

  // --------------------------------------------------------------------------
  // invoke
  // --------------------------------------------------------------------------

  describe("invoke", () => {
    const okResult = (over: Record<string, unknown> = {}) => ({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            result: {
              runId: "run_1",
              functionId: "my-fn",
              status: "RUN_STATUS_COMPLETED",
              output: { ok: true },
              durationMs: 7,
              ...over,
            },
          })
        ),
    });

    it("calls InvokeFunctionSync with the function id and returns one result", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue(okResult());
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.invoke("my-fn", { data: { key: "value" } });

      expect(result).toEqual({
        runId: "run_1",
        functionId: "my-fn",
        status: "completed",
        output: { ok: true },
        error: undefined,
        durationMs: 7,
      });
      // No waitTimedOut on the single-run shape — invoke throws instead.
      expect("waitTimedOut" in result).toBe(false);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.IronflowService/InvokeFunctionSync"
      );
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.function_id).toBe("my-fn");
      expect(body.event).toBeUndefined();
      expect(body.data).toEqual({ key: "value" });
      expect(body.timeout_ms).toBe(30000);
    });

    it("threads idempotencyKey, metadata and a custom timeout into the body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue(okResult());
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("my-fn", {
        data: {},
        timeout: 90000,
        idempotencyKey: "idem-invoke-1",
        metadata: { source: "test" },
      });

      const body = JSON.parse(
        assertDefined(mockFetch.mock.calls[0]?.[1]).body as string
      );
      expect(body.timeout_ms).toBe(90000);
      expect(body.idempotency_key).toBe("idem-invoke-1");
      expect(body.metadata).toEqual({ source: "test" });
    });

    it("does not turn `timeout` into a transport abort", async () => {
      // The server cancels the run when the request context dies, so the wait
      // budget must never become a fetch deadline. The response lands at 25ms,
      // BETWEEN the 20ms budget and the 20ms + SYNC_TRANSPORT_HEADROOM
      // transport deadline: a deadline set to the bare budget aborts first,
      // which the server reads as an abandoned caller and cancels the run.
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        timeout: 10,
        logger: false,
      });
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(okResult()), 25);
            options.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        ironflow.invoke("slow-fn", { data: {}, timeout: 20 })
      ).resolves.toMatchObject({ runId: "run_1", status: "completed" });
    });

    it("throws RunWaitTimeoutError when the wait budget expired", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          okResult({
            runId: "run_waiting",
            status: "RUN_STATUS_RUNNING",
            output: null,
            waitTimedOut: true,
          })
        )
      );

      await expect(
        ironflow.invoke("my-fn", { data: {}, timeout: 1234 })
      ).rejects.toMatchObject({
        name: "RunWaitTimeoutError",
        code: "RUN_WAIT_TIMEOUT",
        runId: "run_waiting",
        runStatus: "running",
        timeoutMs: 1234,
      });
    });

    it("throws RunFailedError when the run failed", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          okResult({
            runId: "run_fail",
            status: "RUN_STATUS_FAILED",
            output: { partial: true },
            error: { message: "something broke", code: "STEP_FAILED" },
          })
        )
      );

      const err = (await ironflow
        .invoke("my-fn", { data: {} })
        .catch((e: unknown) => e)) as Record<string, unknown> & {
        constructor: { name: string };
      };
      expect(err.constructor.name).toBe("RunFailedError");
      expect(err.runId).toBe("run_fail");
      expect(err.code).toBe("RUN_FAILED");
      expect(err.message).toBe("something broke");
      expect(err.output).toEqual({ partial: true });
    });

    it("throws RunCancelledError when the run was cancelled", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          okResult({ runId: "run_cancel", status: "RUN_STATUS_CANCELLED", output: null })
        )
      );

      await expect(ironflow.invoke("my-fn", { data: {} })).rejects.toMatchObject({
        name: "RunCancelledError",
        code: "RUN_CANCELLED",
        runId: "run_cancel",
      });
    });

    it("rejects a response with no result — the field is required", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({})),
        })
      );

      await expect(ironflow.invoke("my-fn", { data: {} })).rejects.toMatchObject({
        name: "ValidationError",
        code: "VALIDATION_ERROR",
      });
    });

    it("aborts the transport when the caller's signal fires", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      let aborted = false;
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );
      vi.stubGlobal("fetch", mockFetch);

      const ac = new AbortController();
      const pending = ironflow.invoke("my-fn", {
        data: {},
        signal: ac.signal,
      });
      ac.abort();

      // AbortError, NOT a retryable TIMEOUT — the caller cancelled on purpose.
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(aborted).toBe(true);
    });

    it("never reaches the network when the signal is already aborted", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      );
      vi.stubGlobal("fetch", mockFetch);

      const ac = new AbortController();
      ac.abort();

      await expect(
        ironflow.invoke("my-fn", { data: {}, signal: ac.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("includes auth and environment headers", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        environment: "staging",
        auth: { apiKey: "test-key-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue(okResult());
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("fn-3", { data: {} });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer test-key-123");
      expect(headers["X-Ironflow-Environment"]).toBe("staging");
    });

    it("includes auth header when token is configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "jwt-token-456" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue(okResult());
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("fn-4", { data: {} });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer jwt-token-456");
    });
  });

  // --------------------------------------------------------------------------
  // getRun + mapRunResponse
  // --------------------------------------------------------------------------

  describe("getRun", () => {
    it("normalizes proto enum status RUN_STATUS_COMPLETED to completed", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_1",
                functionId: "fn-1",
                eventId: "evt-1",
                status: "RUN_STATUS_COMPLETED",
                attempt: 1,
                maxAttempts: 3,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:01:00Z",
              })
            ),
        })
      );

      const run = await ironflow.getRun("run_1");
      expect(run.id).toBe("run_1");
      expect(run.status).toBe("completed");
      expect(run.functionId).toBe("fn-1");
      expect(run.attempt).toBe(1);
      expect(run.maxAttempts).toBe(3);
    });

    it("normalizes RUN_STATUS_RUNNING to running", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_2",
                functionId: "fn-2",
                eventId: "evt-2",
                status: "RUN_STATUS_RUNNING",
                attempt: 1,
                maxAttempts: 3,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:01:00Z",
              })
            ),
        })
      );

      const run = await ironflow.getRun("run_2");
      expect(run.status).toBe("running");
    });

    it("normalizes RUN_STATUS_FAILED to failed", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_3",
                functionId: "fn-3",
                eventId: "evt-3",
                status: "RUN_STATUS_FAILED",
                attempt: 3,
                maxAttempts: 3,
                error: { message: "step exploded", code: "STEP_FAILED" },
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:05:00Z",
              })
            ),
        })
      );

      const run = await ironflow.getRun("run_3");
      expect(run.status).toBe("failed");
      expect(run.error).toEqual({
        message: "step exploded",
        code: "STEP_FAILED",
      });
    });

    it("rejects a lowercase wire status", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_4",
                functionId: "fn-4",
                eventId: "evt-4",
                status: "cancelled",
                attempt: 1,
                maxAttempts: 3,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:01:00Z",
              })
            ),
        })
      );

      await expect(ironflow.getRun("run_4")).rejects.toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    });

    it("rejects an unknown wire status", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_5",
                functionId: "fn-5",
                eventId: "evt-5",
                status: "RUN_STATUS_UNKNOWN_THING",
                attempt: 1,
                maxAttempts: 3,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:01:00Z",
              })
            ),
        })
      );

      await expect(ironflow.getRun("run_5")).rejects.toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    });

    it("converts date strings to Date objects", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_6",
                functionId: "fn-6",
                eventId: "evt-6",
                status: "RUN_STATUS_COMPLETED",
                attempt: 1,
                maxAttempts: 3,
                startedAt: "2026-01-01T00:00:00Z",
                endedAt: "2026-01-01T00:05:00Z",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:05:00Z",
              })
            ),
        })
      );

      const run = await ironflow.getRun("run_6");
      expect(run.startedAt).toBeInstanceOf(Date);
      expect(run.endedAt).toBeInstanceOf(Date);
      expect(run.createdAt).toBeInstanceOf(Date);
      expect(run.updatedAt).toBeInstanceOf(Date);
    });

    it("leaves startedAt/endedAt undefined when not in response", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "run_7",
                functionId: "fn-7",
                eventId: "evt-7",
                status: "RUN_STATUS_RUNNING",
                attempt: 1,
                maxAttempts: 3,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              })
            ),
        })
      );

      const run = await ironflow.getRun("run_7");
      expect(run.startedAt).toBeUndefined();
      expect(run.endedAt).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // listRuns
  // --------------------------------------------------------------------------

  describe("listRuns", () => {
    it("returns list of runs with normalized statuses", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                runs: [
                  {
                    id: "run_a",
                    functionId: "fn-1",
                    eventId: "evt-a",
                    status: "RUN_STATUS_COMPLETED",
                    attempt: 1,
                    maxAttempts: 3,
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:01:00Z",
                  },
                  {
                    id: "run_b",
                    functionId: "fn-1",
                    eventId: "evt-b",
                    status: "RUN_STATUS_RUNNING",
                    attempt: 1,
                    maxAttempts: 3,
                    createdAt: "2026-01-02T00:00:00Z",
                    updatedAt: "2026-01-02T00:01:00Z",
                  },
                ],
                nextCursor: "cursor_abc",
                totalCount: 42,
              })
            ),
        })
      );

      const result = await ironflow.listRuns({ functionId: "fn-1", limit: 2 });

      expect(result.runs).toHaveLength(2);
      expect(assertDefined(result.runs[0]).status).toBe("completed");
      expect(assertDefined(result.runs[1]).status).toBe("running");
      expect(result.nextCursor).toBe("cursor_abc");
      expect(result.totalCount).toBe(42);
    });

    it("sends filter parameters in request body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ runs: [], totalCount: 0 })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.listRuns({
        functionId: "fn-x",
        status: "completed",
        limit: 10,
        cursor: "page2",
      });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.function_id).toBe("fn-x");
      // Protobuf enum field: only the canonical name survives the trip (#1919).
      expect(body.status).toBe("RUN_STATUS_COMPLETED");
      expect(body.limit).toBe(10);
      expect(body.cursor).toBe("page2");
    });

    it("defaults to empty runs and zero totalCount", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({})),
        })
      );

      const result = await ironflow.listRuns();
      expect(result.runs).toEqual([]);
      expect(result.totalCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // cancelRun
  // --------------------------------------------------------------------------

  describe("cancelRun", () => {
    it("sends cancel request and returns normalized run", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: "run_c",
              functionId: "fn-c",
              eventId: "evt-c",
              status: "RUN_STATUS_CANCELLED",
              attempt: 1,
              maxAttempts: 3,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:02:00Z",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const run = await ironflow.cancelRun("run_c", "user requested");

      expect(run.id).toBe("run_c");
      expect(run.status).toBe("cancelled");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.IronflowService/CancelRun"
      );
      const body = JSON.parse(opts.body);
      expect(body.id).toBe("run_c");
      expect(body.reason).toBe("user requested");
    });
  });

  // --------------------------------------------------------------------------
  // emit
  // --------------------------------------------------------------------------

  describe("emit", () => {
    it("sends emit request to PubSubService/Emit endpoint", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ runIds: ["run_e"], eventId: "evt_e" })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.emit("order.created", { orderId: "123" });

      expect(result.runIds).toEqual(["run_e"]);
      expect(result.eventId).toBe("evt_e");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.PubSubService/Emit"
      );
      const body = JSON.parse(opts.body);
      expect(body.event).toBe("order.created");
      expect(body.data).toEqual({ orderId: "123" });
    });

    it("includes version when provided in options", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ runIds: [], eventId: "evt_v" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emit("order.updated", {}, { version: 2 });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.version).toBe(2);
    });

    it("omits version when not provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ runIds: [], eventId: "evt_nv" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emit("order.deleted", {});

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.version).toBeUndefined();
    });

    it("includes metadata and idempotencyKey", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ runIds: [], eventId: "evt_m" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emit("payment.processed", { amount: 99 }, {
        idempotencyKey: "idem-1",
        metadata: { source: "checkout" },
        namespace: "payments",
      });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.idempotency_key).toBe("idem-1");
      expect(body.metadata).toEqual({ source: "checkout" });
      expect(body.namespace).toBe("payments");
    });
  });

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------

  describe("publish", () => {
    it("publishes topic data and maps the sequence to a number", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ eventId: "evt_pub", sequence: "42" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.publish(
        "notifications",
        { message: "hello" },
        { idempotencyKey: "publish-1" }
      );

      expect(result).toEqual({ eventId: "evt_pub", sequence: 42 });
      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.PubSubService/Publish"
      );
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({
        topic: "notifications",
        data: { message: "hello" },
        idempotencyKey: "publish-1",
      });
    });

    it("uses an empty object when data is null", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ eventId: "evt_pub", sequence: 1 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.publish("notifications", null);

      const body = JSON.parse(
        assertDefined(mockFetch.mock.calls[0]?.[1]).body as string
      );
      expect(body).toEqual({ topic: "notifications", data: {} });
    });
  });

  // --------------------------------------------------------------------------
  // emitSync
  // --------------------------------------------------------------------------

  describe("emitSync", () => {
    it("returns one result per matched run", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_abc123",
                  functionId: "my-function",
                  status: "RUN_STATUS_COMPLETED",
                  output: { total: 99.99 },
                  durationMs: 42,
                },
              ],
              eventId: "evt_abc",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const results = await ironflow.emitSync("order.placed", {
        orderId: "123",
      });

      expect(results).toHaveLength(1);
      const result = assertDefined(results[0]);
      expect(result.runId).toBe("run_abc123");
      expect(result.functionId).toBe("my-function");
      expect(result.status).toBe("completed");
      expect(result.output).toEqual({ total: 99.99 });
      expect(result.durationMs).toBe(42);
      expect(result.waitTimedOut).toBe(false);

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.IronflowService/TriggerSync"
      );
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.event).toBe("order.placed");
      expect(body.data).toEqual({ orderId: "123" });
      expect(body.timeout_ms).toBe(30000);
    });

    it("returns EVERY run of a fan-out, dropping none", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                results: [
                  {
                    runId: "run_1",
                    functionId: "fn-a",
                    status: "RUN_STATUS_COMPLETED",
                    output: { a: 1 },
                    durationMs: 3,
                  },
                  {
                    runId: "run_2",
                    functionId: "fn-b",
                    status: "RUN_STATUS_COMPLETED",
                    output: { b: 2 },
                    durationMs: 4,
                  },
                  {
                    runId: "run_3",
                    functionId: "fn-c",
                    status: "RUN_STATUS_COMPLETED",
                    output: { c: 3 },
                    durationMs: 5,
                  },
                ],
                eventId: "evt_fan",
              })
            ),
        })
      );

      const results = await ironflow.emitSync("order.placed", {});

      expect(results.map((r) => r.runId)).toEqual(["run_1", "run_2", "run_3"]);
      expect(results.map((r) => r.functionId)).toEqual(["fn-a", "fn-b", "fn-c"]);
      expect(results.map((r) => r.output)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it("reports a mixed fan-out per run instead of throwing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                results: [
                  {
                    runId: "run_ok",
                    functionId: "fn-ok",
                    status: "RUN_STATUS_COMPLETED",
                    output: { ok: true },
                    durationMs: 2,
                  },
                  {
                    runId: "run_fail",
                    functionId: "fn-fail",
                    status: "RUN_STATUS_FAILED",
                    output: { partial: true },
                    error: { message: "something broke", code: "STEP_FAILED" },
                    durationMs: 5,
                  },
                  {
                    runId: "run_cancel",
                    functionId: "fn-cancel",
                    status: "RUN_STATUS_CANCELLED",
                    output: null,
                    durationMs: 1,
                  },
                  {
                    runId: "run_waiting",
                    functionId: "fn-slow",
                    status: "RUN_STATUS_RUNNING",
                    output: null,
                    waitTimedOut: true,
                  },
                ],
                eventId: "evt_mixed",
              })
            ),
        })
      );

      // The whole point of Q12: one failed run must not hide the other three.
      const results = await ironflow.emitSync("order.placed", {});

      expect(results).toHaveLength(4);
      expect(results.map((r) => r.status)).toEqual([
        "completed",
        "failed",
        "cancelled",
        "running",
      ]);
      expect(assertDefined(results[1]).error).toEqual({
        message: "something broke",
        code: "STEP_FAILED",
      });
      expect(assertDefined(results[1]).output).toEqual({ partial: true });
      expect(assertDefined(results[2]).error).toBeUndefined();
      expect(assertDefined(results[3]).waitTimedOut).toBe(true);
      expect(results.filter((r) => r.waitTimedOut)).toHaveLength(1);
    });

    it("returns an empty array when the event matched nothing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(JSON.stringify({ results: [], eventId: "evt_empty" })),
        })
      );

      // Not an error: an event with no matching trigger legitimately produces
      // no runs — the server returns `results: []` on success.
      await expect(ironflow.emitSync("test.event", {})).resolves.toEqual([]);
    });

    it("returns an empty array when results is omitted entirely", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ eventId: "evt_none" })),
        })
      );

      await expect(ironflow.emitSync("test.event", {})).resolves.toEqual([]);
    });

    it("passes custom timeout in request body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_t",
                  functionId: "fn",
                  status: "RUN_STATUS_COMPLETED",
                  output: null,
                  durationMs: 1,
                },
              ],
              eventId: "evt_t",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emitSync("ping", {}, { timeout: 60000 });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.timeout_ms).toBe(60000);
    });

    it("threads idempotencyKey into the request body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_i",
                  functionId: "fn",
                  status: "RUN_STATUS_COMPLETED",
                  output: null,
                  durationMs: 1,
                },
              ],
              eventId: "evt_i",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emitSync("ping", {}, { idempotencyKey: "idem-emit-1" });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.idempotency_key).toBe("idem-emit-1");
    });

    // #1955. TriggerSync only gained a version field in that change, so the
    // option it reaches is new on both sides of the wire.
    it("sends the schema version on emitSync", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ results: [], eventId: "evt_v" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emitSync("ping", {}, { version: 2 });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.version).toBe(2);
    });

    // The emit guard moved off truthiness so a negative reaches the server and
    // returns a 400 with the reason, rather than being dropped and emitted at
    // version 1. Under the old `options?.version ? ... : {}` this fails.
    it("forwards a negative version on emit instead of dropping it", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ runIds: [], eventId: "evt_neg" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emit("ping", {}, { version: -1 });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.version).toBe(-1);
    });

    it("omits idempotency_key when none is given", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ results: [], eventId: "evt_n" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.emitSync("ping", {});

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect("idempotency_key" in body).toBe(false);
    });

    it("lets the per-call wait exceed the global request timeout", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        timeout: 10,
        logger: false,
      });
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((resolve, reject) => {
            const responseTimer = setTimeout(
              () =>
                resolve({
                  ok: true,
                  text: () =>
                    Promise.resolve(
                      JSON.stringify({
                        results: [
                          {
                            runId: "run_slow",
                            functionId: "slow-function",
                            status: "RUN_STATUS_COMPLETED",
                            output: { done: true },
                            durationMs: 25,
                          },
                        ],
                        eventId: "evt_slow",
                      })
                    ),
                }),
              25
            );
            options.signal?.addEventListener("abort", () => {
              clearTimeout(responseTimer);
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );
      vi.stubGlobal("fetch", mockFetch);

      // `timeout` is a server-side budget, never a fetch deadline: an abort
      // here would cancel the run and make `waitTimedOut` unobservable. The
      // response lands at 25ms, BETWEEN the 20ms budget and the
      // 20ms + SYNC_TRANSPORT_HEADROOM deadline, so a deadline set to the bare
      // budget fails this test.
      const results = await ironflow.emitSync("work.started", {}, { timeout: 20 });
      expect(assertDefined(results[0])).toMatchObject({
        runId: "run_slow",
        status: "completed",
      });
    });

    it("reports an expired wait budget as waitTimedOut, not a throw", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                results: [
                  {
                    runId: "run_waiting",
                    functionId: "slow-function",
                    status: "RUN_STATUS_WAITING",
                    waitTimedOut: true,
                  },
                ],
                eventId: "evt_waiting",
              })
            ),
        })
      );

      const results = await ironflow.emitSync("work.started", {}, { timeout: 1234 });
      expect(assertDefined(results[0])).toMatchObject({
        runId: "run_waiting",
        functionId: "slow-function",
        status: "waiting",
        waitTimedOut: true,
      });
    });

    it("reports a failed run in the result, not as RunFailedError", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                results: [
                  {
                    runId: "run_fail",
                    functionId: "my-function",
                    status: "RUN_STATUS_FAILED",
                    output: { partial: true },
                    error: { message: "something broke", code: "STEP_FAILED" },
                    durationMs: 5,
                  },
                ],
                eventId: "evt_f",
              })
            ),
        })
      );

      const results = await ironflow.emitSync("order.placed", {});
      const result = assertDefined(results[0]);
      expect(result.status).toBe("failed");
      expect(result.error).toEqual({
        message: "something broke",
        code: "STEP_FAILED",
      });
      expect(result.output).toEqual({ partial: true });
    });

    it("reports a cancelled run in the result, not as RunCancelledError", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                results: [
                  {
                    runId: "run_cancel",
                    functionId: "my-function",
                    status: "RUN_STATUS_CANCELLED",
                    output: null,
                    durationMs: 0,
                  },
                ],
                eventId: "evt_c",
              })
            ),
        })
      );

      const results = await ironflow.emitSync("order.placed", {});
      expect(assertDefined(results[0]).status).toBe("cancelled");
    });

    it("still throws on a transport failure", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "engine unavailable" })),
        })
      );

      await expect(ironflow.emitSync("order.placed", {})).rejects.toMatchObject({
        status: 503,
        retryable: true,
      });
    });

    it("rejects an unspecified wire status", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_unspecified",
                  functionId: "my-function",
                  status: "RUN_STATUS_UNSPECIFIED",
                  durationMs: 0,
                },
              ],
              eventId: "evt_unspecified",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(ironflow.emitSync("order.placed", {})).rejects.toMatchObject({
        name: "ValidationError",
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    });

    it("throws when not configured", async () => {
      // ironflow is reset in afterEach, so it's not configured here
      await expect(ironflow.emitSync("test.event", {})).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // patchStep (uses direct fetch, not request() helper)
  // --------------------------------------------------------------------------

  describe("patchStep", () => {
    it("POSTs to /api/v1/steps/patch with correct body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.patchStep("step-abc", { result: "fixed" }, "manual fix");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/steps/patch");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.step_id).toBe("step-abc");
      expect(body.output).toEqual({ result: "fixed" });
      expect(body.reason).toBe("manual fix");
    });

    it("defaults reason to empty string", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.patchStep("step-1", { val: 1 });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.reason).toBe("");
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "step not found" })),
        })
      );

      await expect(
        ironflow.patchStep("step-missing", { x: 1 })
      ).rejects.toThrow("step not found");
    });
  });

  // --------------------------------------------------------------------------
  // resumeRun (#1963: on the Connect RPC, via request(), like getRun/cancelRun)
  // --------------------------------------------------------------------------

  describe("resumeRun", () => {
    it("POSTs the ResumeRun RPC with lowerCamel proto fields", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        // protojson, same shape getRun and cancelRun already decode. It used to
        // be the REST route's snake_case store.Run, which needed a decoder of
        // its own (mapRestRunResponse, deleted with this change).
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: "run_re",
              status: "RUN_STATUS_RUNNING",
              functionId: "fn-re",
              eventId: "evt-re",
              attempt: 2,
              maxAttempts: 3,
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:01:00Z",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.resumeRun("run_re", "step-3");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.IronflowService/ResumeRun"
      );
      const body = JSON.parse(opts.body);
      expect(body.runId).toBe("run_re");
      expect(body.fromStep).toBe("step-3");

      expect(result.id).toBe("run_re");
      expect(result.status).toBe("running");
      expect(result.functionId).toBe("fn-re");
      expect(result.eventId).toBe("evt-re");
      expect(result.maxAttempts).toBe(3);
      expect(result.createdAt).toEqual(new Date("2025-01-01T00:00:00Z"));
    });

    it("defaults fromStep to empty string", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ id: "run_re2", status: "RUN_STATUS_RUNNING" })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.resumeRun("run_re2");

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.fromStep).toBe("");
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "internal error" })),
        })
      );

      await expect(ironflow.resumeRun("run_fail")).rejects.toThrow(
        "internal error"
      );
    });

    // #1963: the whole point of the migration. A resume already inside the
    // server's dedupe window is 409 -> already_exists, and going through
    // request() means it now carries the status and a non-retryable flag
    // instead of the bare code:"RESUME_FAILED" the hand-rolled fetch invented.
    it("surfaces a deduplicated resume as a non-retryable 409", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                code: "already_exists",
                message:
                  "a resume for this run is already in flight; wait for it to land before retrying",
              })
            ),
        })
      );

      await expect(ironflow.resumeRun("run_dup")).rejects.toMatchObject({
        status: 409,
        retryable: false,
        message:
          "a resume for this run is already in flight; wait for it to land before retrying",
      });
    });
  });

  // --------------------------------------------------------------------------
  // Function lifecycle
  // --------------------------------------------------------------------------

  describe("function lifecycle", () => {
    it("wraps all function versioning operations", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "fn-1", status: "FUNCTION_STATUS_ACTIVE" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "fn-1", status: "FUNCTION_STATUS_ARCHIVED" }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            entries: [{ eventId: "evt-1", entityVersion: "8", functionId: "fn-1", changeType: "update" }],
            hasMore: false,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            entry: { eventId: "evt-2", entityVersion: "4", functionId: "fn-1", changeType: "update" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ function: { id: "fn-1", status: "FUNCTION_STATUS_ACTIVE" } }),
        });
      vi.stubGlobal("fetch", mockFetch);

      expect((await ironflow.getFunction("fn-1")).status).toBe("active");
      expect((await ironflow.updateFunctionStatus("fn-1", "archived")).status).toBe("archived");
      await ironflow.deleteFunction("fn-1");
      expect((await ironflow.listFunctionHistory("fn-1", { limit: 10, fromVersion: 9 })).entries[0]?.entityVersion).toBe(8);
      expect((await ironflow.getFunctionAtVersion("fn-1", 4)).entityVersion).toBe(4);
      expect((await ironflow.rollbackFunction("fn-1", 4, "restore")).status).toBe("active");

      const calls = mockFetch.mock.calls.map(([url, init]) => ({
        path: new URL(url as string).pathname,
        body: JSON.parse((init as RequestInit).body as string),
      }));
      expect(calls.map((call) => call.path)).toEqual([
        "/ironflow.v1.IronflowService/GetFunction",
        "/ironflow.v1.IronflowService/UpdateFunctionStatus",
        "/ironflow.v1.IronflowService/DeleteFunction",
        "/ironflow.v1.IronflowService/ListFunctionHistory",
        "/ironflow.v1.IronflowService/GetFunctionAtVersion",
        "/ironflow.v1.IronflowService/RollbackFunction",
      ]);
      expect(calls[1]?.body).toEqual({ id: "fn-1", status: "FUNCTION_STATUS_ARCHIVED" });
      expect(calls[3]?.body).toEqual({ functionId: "fn-1", limit: 10, fromVersion: "9" });
      expect(calls[5]?.body).toEqual({ functionId: "fn-1", version: "4", changeReason: "restore" });
    });
  });

  describe("triggerBatch", () => {
    it("sends multiple event inputs to TriggerBatch", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [{ runIds: ["run-1"], eventId: "evt-1" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(ironflow.triggerBatch([
        { event: "order.placed", data: { id: "1" }, idempotencyKey: "order-1" },
      ])).resolves.toEqual([{ runIds: ["run-1"], eventId: "evt-1" }]);

      const [url, init] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/ironflow.v1.IronflowService/TriggerBatch");
      expect(JSON.parse(init.body as string)).toEqual({
        events: [{ event: "order.placed", data: { id: "1" }, idempotencyKey: "order-1" }],
      });
    });
  });

  describe("event reads", () => {
    it("lists events, gets one event, and lists name facets", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            events: [{
              id: "evt-1",
              name: "order.placed",
              timestamp: "2026-08-27T12:00:00.123Z",
              source: "sdk",
              processed: true,
              created_at: "2026-08-27T12:00:00.123Z",
              run_id: "run-1",
            }],
            count: 1,
            limit: 20,
            has_next: false,
            has_prev: false,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "evt-1",
            name: "order.placed",
            timestamp: "2026-08-27T12:00:00.123Z",
            source: "sdk",
            processed: true,
            created_at: "2026-08-27T12:00:00.123Z",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ names: [], scanned: 0, truncated: false, scan_cap: 10000 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      expect((await ironflow.listEvents({ search: "evt", before: "prev" })).events[0]?.runId).toBe("run-1");
      expect((await ironflow.getEvent("evt-1")).id).toBe("evt-1");
      expect((await ironflow.listEventNames()).scanCap).toBe(10000);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:9123/api/v1/events?search=evt&before=prev",
        "http://localhost:9123/api/v1/events/evt-1",
        "http://localhost:9123/api/v1/events/names",
      ]);
    });
  });

  describe("run introspection", () => {
    it("returns durable steps and touched entity streams", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            steps: [{ id: "row-1", run_id: "run-1", step_id: "charge", step_type: "invoke", sequence: 1, status: "completed", attempt: 1, created_at: "now", updated_at: "now" }],
            count: 1,
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ entity_ids: ["order-1"] }) });
      vi.stubGlobal("fetch", mockFetch);

      expect((await ironflow.getRunSteps("run-1")).steps[0]?.stepId).toBe("charge");
      expect(await ironflow.getRunStreams("run-1")).toEqual({ entityIds: ["order-1"] });
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:9123/api/v1/runs/run-1/steps",
        "http://localhost:9123/api/v1/runs/run-1/streams",
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // listFunctions (uses direct fetch)
  // --------------------------------------------------------------------------

  describe("listFunctions", () => {
    it("returns functions array from server", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const fns = [
        { id: "fn-1", name: "process-order" },
        { id: "fn-2", name: "send-email" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ functions: fns }),
        })
      );

      const result = await ironflow.listFunctions();
      expect(result).toEqual(fns);
    });

    it("returns empty array when functions field is missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const result = await ironflow.listFunctions();
      expect(result).toEqual([]);
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 503 })
      );

      await expect(ironflow.listFunctions()).rejects.toThrow(
        "List functions failed: 503"
      );
    });
  });

  // --------------------------------------------------------------------------
  // listWorkers (uses direct fetch)
  // --------------------------------------------------------------------------

  describe("listWorkers", () => {
    it("returns workers array from server", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const workers = [{ id: "w-1", status: "active" }];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ workers }),
        })
      );

      const result = await ironflow.listWorkers();
      expect(result).toEqual(workers);
    });

    it("returns empty array when workers field is missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const result = await ironflow.listWorkers();
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // health (uses direct fetch)
  // --------------------------------------------------------------------------

  describe("health", () => {
    it("returns health data from server", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const healthData = {
        status: "ok",
        timestamp: "2026-01-01T00:00:00Z",
        version: "1.0.0",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(healthData),
        })
      );

      const result = await ironflow.health();
      expect(result).toEqual(healthData);
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 503 })
      );

      await expect(ironflow.health()).rejects.toThrow(
        "Health check failed: 503"
      );
    });
  });

  // --------------------------------------------------------------------------
  // getCapabilities (uses direct fetch)
  // --------------------------------------------------------------------------

  describe("getCapabilities", () => {
    it("returns capabilities from server", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const caps = {
        transports: ["connectrpc"],
        features: ["replay"],
        version: "1.0.0",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(caps),
        })
      );

      const result = await ironflow.getCapabilities();
      expect(result).toEqual(caps);
    });
  });

  // --------------------------------------------------------------------------
  // detectTransport
  // --------------------------------------------------------------------------

  describe("detectTransport", () => {
    it("returns connectrpc when server responds ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ transports: ["connectrpc"] }),
        })
      );

      const transport = await ironflow.detectTransport();
      expect(transport).toBe("connectrpc");
    });

    it("returns websocket when fetch fails", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error"))
      );

      const transport = await ironflow.detectTransport();
      expect(transport).toBe("websocket");
    });

    it("works without configure (uses default serverUrl)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const transport = await ironflow.detectTransport();
      expect(transport).toBe("connectrpc");
    });
  });

  // --------------------------------------------------------------------------
  // Error handling in request() private method
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws IronflowError with parsed error body on non-ok response", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                code: "NOT_FOUND",
                message: "Run not found",
              })
            ),
        })
      );

      await expect(ironflow.getRun("run-missing")).rejects.toThrow(
        "Run not found"
      );
    });

    it("throws IronflowError with status when body is not JSON", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          text: () => Promise.resolve("Bad Gateway"),
        })
      );

      await expect(ironflow.getRun("run-x")).rejects.toThrow("Bad Gateway");
    });

    it("throws ValidationError when response is not valid JSON", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve("not-json{{{"),
        })
      );

      await expect(ironflow.getRun("run-y")).rejects.toThrow(
        "Invalid JSON response"
      );
    });

    it("throws ValidationError when response fails schema validation", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(JSON.stringify({ wrong: "shape" })),
        })
      );

      await expect(ironflow.getRun("run-z")).rejects.toThrow(
        "Invalid response from server"
      );
    });

    it("wraps network errors as IronflowError with REQUEST_FAILED code", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
      );

      try {
        await ironflow.getRun("run-net");
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect((err as Error).message).toContain("Failed to fetch");
      }
    });

    it("throws timeout error when fetch is aborted", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        timeout: 1, // 1ms timeout
        logger: false,
      });
      // Simulate a slow fetch that never resolves
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          (_url: string, opts: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts?.signal?.addEventListener("abort", () => {
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            })
        )
      );

      await expect(ironflow.getRun("run-timeout")).rejects.toThrow("timeout");
    });

    it("marks 5xx errors as retryable", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "Service unavailable" })),
        })
      );

      try {
        await ironflow.getRun("run-503");
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        const e = err as { retryable?: boolean; message: string };
        expect(e.message).toBe("Service unavailable");
        expect(e.retryable).toBe(true);
      }
    });

    it("marks 4xx errors as not retryable", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "Bad request" })),
        })
      );

      try {
        await ironflow.getRun("run-400");
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        const e = err as { retryable?: boolean; message: string };
        expect(e.message).toBe("Bad request");
        expect(e.retryable).toBe(false);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Entity streams (via real module)
  // --------------------------------------------------------------------------

  describe("streams.append", () => {
    it("sends correct request and returns mapped result", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ entityVersion: 3, eventId: "evt-new" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.streams.append("order-123", {
        name: "order.shipped",
        data: { trackingId: "ABC" },
        entityType: "order",
      });

      expect(result.entityVersion).toBe(3);
      expect(result.eventId).toBe("evt-new");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.EntityStreamService/AppendEvent"
      );
      const body = JSON.parse(opts.body);
      expect(body.entity_id).toBe("order-123");
      expect(body.entity_type).toBe("order");
      expect(body.event_name).toBe("order.shipped");
      expect(body.data).toEqual({ trackingId: "ABC" });
      expect(body.expected_version).toBe(-1);
      expect(body.idempotency_key).toBe("");
      expect(body.version).toBe(1);
    });

    it("passes options when provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ entityVersion: 5, eventId: "evt-opt" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.streams.append(
        "order-456",
        { name: "order.updated", data: {}, entityType: "order" },
        { expectedVersion: 4, idempotencyKey: "idem-1", version: 2 }
      );

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.expected_version).toBe(4);
      expect(body.idempotency_key).toBe("idem-1");
      expect(body.version).toBe(2);
    });

    it("includes metadata in request body when provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ entityVersion: 1, eventId: "evt-meta" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.streams.append(
        "order-meta",
        { name: "order.placed", data: { total: 100 }, entityType: "order" },
        {
          expectedVersion: 0,
          metadata: {
            causationId: "cmd-abc",
            correlationId: "corr-xyz",
            tenantId: "tenant-42",
          },
        }
      );

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.metadata).toEqual({
        causationId: "cmd-abc",
        correlationId: "corr-xyz",
        tenantId: "tenant-42",
      });
    });

    it("omits metadata from body when not provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ entityVersion: 1, eventId: "evt-no-meta" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.streams.append(
        "order-no-meta",
        { name: "order.placed", data: {}, entityType: "order" }
      );

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body).not.toHaveProperty("metadata");
    });

    it("throws on error response", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "version conflict" })
            ),
        })
      );

      await expect(
        ironflow.streams.append("order-789", {
          name: "order.created",
          data: {},
          entityType: "order",
        })
      ).rejects.toThrow("version conflict");
    });

    it("throws IronflowError with code HTTP_409 on version conflict", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "optimistic locking failure" })
            ),
        })
      );

      try {
        await ironflow.streams.append("order-conflict", {
          name: "order.updated",
          data: { total: 200 },
          entityType: "order",
        });
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        const e = err as { code?: string; retryable?: boolean; message: string };
        expect(e.message).toBe("optimistic locking failure");
        expect(e.code).toBe("HTTP_409");
        expect(e.retryable).toBe(false);
      }
    });
  });

  describe("streams.read", () => {
    it("returns mapped events with correct field renaming", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "e1",
                  name: "order.created",
                  data: { total: 100 },
                  entityVersion: 1,
                  version: 1,
                  timestamp: "2026-01-01T00:00:00Z",
                  source: "api",
                  metadata: { user: "admin" },
                },
              ],
              totalCount: 1,
            }),
        })
      );

      const result = await ironflow.streams.read("order-123", { limit: 10 });
      expect(result.totalCount).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        id: "e1",
        name: "order.created",
        data: { total: 100 },
        entityVersion: 1,
        version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        source: "api",
        metadata: { user: "admin" },
      });
    });

    it("sends options parameters in request body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ events: [], totalCount: 0 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.streams.read("user-1", {
        fromVersion: 5,
        limit: 20,
        direction: "backward",
      });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.from_version).toBe(5);
      expect(body.limit).toBe(20);
      expect(body.direction).toBe("backward");
    });

    it("defaults to empty events when missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const result = await ironflow.streams.read("empty");
      expect(result.events).toEqual([]);
      expect(result.totalCount).toBe(0);
    });
  });

  describe("streams.getInfo", () => {
    it("returns mapped stream info", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              entityId: "order-123",
              entityType: "order",
              version: 5,
              eventCount: 5,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-15T12:00:00Z",
            }),
        })
      );

      const info = await ironflow.streams.getInfo("order-123");
      expect(info).toEqual({
        entityId: "order-123",
        entityType: "order",
        version: 5,
        eventCount: 5,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-15T12:00:00Z",
      });
    });

    it("returns null when stream does not exist (404 stream not found)", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "stream not found" })),
        })
      );

      const info = await ironflow.streams.getInfo("never-written");
      expect(info).toBeNull();
    });

    it("rethrows on non-404 errors", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "internal server error" })),
        })
      );

      await expect(ironflow.streams.getInfo("order-123")).rejects.toThrow(
        "internal server error"
      );
    });

    it("rethrows 404s with unrelated messages", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "route not found" })),
        })
      );

      await expect(ironflow.streams.getInfo("order-123")).rejects.toThrow(
        "route not found"
      );
    });
  });

  // --------------------------------------------------------------------------
  // Static patterns
  // --------------------------------------------------------------------------

  describe("static patterns", () => {
    it("exposes patterns helper on class", () => {
      expect(IronflowClient.patterns).toBeDefined();
      expect(typeof IronflowClient.patterns.run).toBe("function");
      expect(typeof IronflowClient.patterns.allRuns).toBe("function");
      expect(typeof IronflowClient.patterns.userEvent).toBe("function");
    });

    it("generates correct run pattern (NATS wildcard >)", () => {
      expect(IronflowClient.patterns.run("run-abc")).toBe(
        "system.run.run-abc.>"
      );
    });

    it("generates correct allRuns pattern", () => {
      expect(IronflowClient.patterns.allRuns()).toBe("system.run.>");
    });

    it("generates correct runSteps pattern", () => {
      expect(IronflowClient.patterns.runSteps("run-abc")).toBe(
        "system.run.run-abc.step.>"
      );
    });

    it("generates correct userEvent pattern", () => {
      expect(IronflowClient.patterns.userEvent("order.*")).toBe(
        "events:order.*"
      );
    });

    it("generates correct runLifecycle pattern", () => {
      expect(IronflowClient.patterns.runLifecycle("run-abc")).toBe(
        "system.run.run-abc.*"
      );
    });
  });

  // --------------------------------------------------------------------------
  // streams.subscribe
  // --------------------------------------------------------------------------

  describe("streams.subscribe", () => {
    it("constructs correct entity pattern", async () => {
      const client = new IronflowClient();
      client.configure({
        serverUrl: "http://localhost:9123",
        logger: false,
      });

      // Mock the subscribe method to capture the pattern
      const mockSub = {
        id: "sub-1",
        pattern: "entity:order.order-123.>",
        connectionState: "connected" as const,
        unsubscribe: vi.fn(),
      };
      const subscribeSpy = vi
        .spyOn(client, "subscribe")
        .mockResolvedValue(mockSub);

      await client.streams.subscribe("order-123", {
        entityType: "order",
        onEvent: vi.fn(),
      });

      expect(subscribeSpy).toHaveBeenCalledWith(
        "entity:order.order-123.>",
        expect.objectContaining({
          onEvent: expect.any(Function),
        })
      );

      client._resetForTesting();
    });

    it("passes replay option through", async () => {
      const client = new IronflowClient();
      client.configure({
        serverUrl: "http://localhost:9123",
        logger: false,
      });

      const mockSub = {
        id: "sub-1",
        pattern: "entity:order.order-123.>",
        connectionState: "connected" as const,
        unsubscribe: vi.fn(),
      };
      const subscribeSpy = vi
        .spyOn(client, "subscribe")
        .mockResolvedValue(mockSub);

      await client.streams.subscribe("order-123", {
        entityType: "order",
        onEvent: vi.fn(),
        replay: 50,
      });

      expect(subscribeSpy).toHaveBeenCalledWith(
        "entity:order.order-123.>",
        expect.objectContaining({
          replay: 50,
        })
      );

      client._resetForTesting();
    });

    it("passes onError callback through", async () => {
      const client = new IronflowClient();
      client.configure({
        serverUrl: "http://localhost:9123",
        logger: false,
      });

      const mockSub = {
        id: "sub-1",
        pattern: "entity:order.order-123.>",
        connectionState: "connected" as const,
        unsubscribe: vi.fn(),
      };
      const subscribeSpy = vi
        .spyOn(client, "subscribe")
        .mockResolvedValue(mockSub);

      const onError = vi.fn();
      await client.streams.subscribe("order-123", {
        entityType: "order",
        onEvent: vi.fn(),
        onError,
      });

      expect(subscribeSpy).toHaveBeenCalledWith(
        "entity:order.order-123.>",
        expect.objectContaining({
          onError: expect.any(Function),
        })
      );

      client._resetForTesting();
    });

    it("returns a subscription with unsubscribe", async () => {
      const client = new IronflowClient();
      client.configure({
        serverUrl: "http://localhost:9123",
        logger: false,
      });

      const mockSub = {
        id: "sub-1",
        pattern: "entity:order.order-123.>",
        connectionState: "connected" as const,
        unsubscribe: vi.fn(),
      };
      vi.spyOn(client, "subscribe").mockResolvedValue(mockSub);

      const sub = await client.streams.subscribe("order-123", {
        entityType: "order",
        onEvent: vi.fn(),
      });

      expect(sub.unsubscribe).toBeDefined();
      sub.unsubscribe();
      expect(mockSub.unsubscribe).toHaveBeenCalled();

      client._resetForTesting();
    });
  });

  // --------------------------------------------------------------------------
  // getProjection
  // --------------------------------------------------------------------------

  describe("getProjection", () => {
    it("returns mapped projection state", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-stats",
              version: 5,
              mode: "managed",
              last_event_seq: 99,
              updated_at: "2026-01-15T10:00:00Z",
              state: {
                projection_name: "order-stats",
                partition_key: "customer-1",
                state: { totalOrders: 42 },
                last_event_id: "evt-99",
                last_event_seq: 99,
                last_event_time: "2026-01-15T10:00:00Z",
                version: 5,
                updated_at: "2026-01-15T10:00:00Z",
              },
            }),
        })
      );

      const result = await ironflow.getProjection("order-stats");

      expect(result.name).toBe("order-stats");
      expect(result.partition).toBe("customer-1");
      expect(result.state).toEqual({ totalOrders: 42 });
      expect(result.lastEventId).toBe("evt-99");
      expect(result.lastEventSeq).toBe(99);
      expect(result.lastEventTime).toBeInstanceOf(Date);
      expect(result.version).toBe(5);
      expect(result.mode).toBe("managed");
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it("appends partition query param when provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            version: 1,
            mode: "managed",
            last_event_seq: 0,
            updated_at: "2026-01-15T10:00:00Z",
            state: {
              projection_name: "order-stats",
              partition_key: "customer-123",
              state: {},
              last_event_id: "",
              last_event_seq: 0,
              version: 1,
              updated_at: "2026-01-15T10:00:00Z",
            },
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.getProjection("order-stats", { partition: "customer-123" });

      const [url] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toContain("?partition=customer-123");
    });

    it("echoes requested partition when no state row exists for it", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            version: 1,
            mode: "managed",
            last_event_seq: 0,
            updated_at: "2026-01-15T10:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.getProjection("order-stats", {
        partition: "no-state-yet",
      });

      expect(result.partition).toBe("no-state-yet");
      expect(result.state).toEqual({});
      expect(result.lastEventTime).toBeUndefined();
    });

    it("sends environment header", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        environment: "staging",
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            version: 1,
            mode: "managed",
            last_event_seq: 0,
            updated_at: "2026-01-15T10:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.getProjection("order-stats");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["X-Ironflow-Environment"]).toBe("staging");
    });

    it("includes auth header when apiKey is configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "test-key-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            version: 1,
            mode: "managed",
            last_event_seq: 0,
            updated_at: "2026-01-15T10:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.getProjection("order-stats");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer test-key-123");
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "projection not found", code: "NOT_FOUND" })
            ),
        })
      );

      await expect(
        ironflow.getProjection("missing")
      ).rejects.toThrow("projection not found");
    });

    it("throws IronflowError with fallback when body is not JSON", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
      );

      await expect(
        ironflow.getProjection("broken")
      ).rejects.toThrow("Get projection failed: 500");
    });

    it("defaults partition to __global__", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-stats",
              state: { state: { count: 1 } },
            }),
        })
      );

      const result = await ironflow.getProjection("order-stats");
      expect(result.partition).toBe("__global__");
    });

    it("throws PROJECTION_ENVELOPE_DRIFT when outer state present but inner state field missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-stats",
              version: 1,
              mode: "managed",
              last_event_seq: 0,
              updated_at: "2026-01-15T10:00:00Z",
              state: { partition_key: "p1" },
            }),
        })
      );

      await expect(ironflow.getProjection("order-stats")).rejects.toThrow(
        /projection envelope drift/
      );
    });
  });

  describe("waitForEvent", () => {
    it("uses the configured bearer token", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        environment: "staging",
        auth: { token: "session-token-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            caughtUp: true,
            currentSeq: 42,
            targetSeq: 42,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.waitForEvent("evt-42", "order-stats");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/projections/wait-for-event"
      );
      expect(opts.headers["Authorization"]).toBe("Bearer session-token-123");
      expect(opts.headers["X-Ironflow-Environment"]).toBe("staging");
    });

    it("prefers an API key when both credentials are configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "api-key-123", token: "session-token-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ caughtUp: true }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.waitForEvent("evt-42", "order-stats");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer api-key-123");
    });
  });

  describe("waitForProjectionCatchup", () => {
    it("uses the configured bearer token", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "session-token-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ caughtUp: true }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.waitForProjectionCatchup("order-stats", { minSeq: 42 });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer session-token-123");
    });
  });

  // --------------------------------------------------------------------------
  // getProjectionStatus
  // --------------------------------------------------------------------------

  describe("getProjectionStatus", () => {
    it("returns mapped projection status", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            status: "active",
            mode: "managed",
            last_event_seq: 42,
            lag: 3,
            updated_at: "2026-01-15T10:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const status = await ironflow.getProjectionStatus("order-stats");

      const [url] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/projections/order-stats/status"
      );
      expect(status.name).toBe("order-stats");
      expect(status.status).toBe("active");
      expect(status.mode).toBe("managed");
      expect(status.lastEventSeq).toBe(42);
      expect(status.lag).toBe(3);
      expect(status.updatedAt).toBeInstanceOf(Date);
    });

    it("handles error_message when present", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "broken-proj",
              status: "error",
              mode: "managed",
              error_message: "handler panicked",
              updated_at: "2026-01-15T10:00:00Z",
            }),
        })
      );

      const status = await ironflow.getProjectionStatus("broken-proj");
      expect(status.errorMessage).toBe("handler panicked");
    });

    it("defaults lastEventSeq and lag to 0", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "new-proj",
              status: "active",
              mode: "managed",
            }),
        })
      );

      const status = await ironflow.getProjectionStatus("new-proj");
      expect(status.lastEventSeq).toBe(0);
      expect(status.lag).toBe(0);
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "projection not found" })
            ),
        })
      );

      await expect(
        ironflow.getProjectionStatus("missing")
      ).rejects.toThrow("projection not found");
    });

    it("includes auth header when configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "secret-key" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "order-stats",
            status: "active",
            mode: "managed",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.getProjectionStatus("order-stats");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer secret-key");
    });
  });

  // --------------------------------------------------------------------------
  // listProjections
  // --------------------------------------------------------------------------

  describe("listProjections", () => {
    it("returns mapped projection status array", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              projections: [
                {
                  name: "order-stats",
                  status: "active",
                  mode: "managed",
                  last_event_seq: 100,
                  updated_at: "2026-01-15T10:00:00Z",
                },
                {
                  name: "user-counts",
                  status: "rebuilding",
                  mode: "external",
                  last_event_seq: 50,
                  error_message: "retrying",
                  updated_at: "2026-01-15T11:00:00Z",
                },
              ],
            }),
        })
      );

      const result = await ironflow.listProjections();

      expect(result).toHaveLength(2);
      const r0 = assertDefined(result[0]);
      const r1 = assertDefined(result[1]);
      expect(r0.name).toBe("order-stats");
      expect(r0.status).toBe("active");
      expect(r0.lastEventSeq).toBe(100);
      expect(r0.updatedAt).toBeInstanceOf(Date);
      expect(r1.name).toBe("user-counts");
      expect(r1.errorMessage).toBe("retrying");
    });

    it("returns empty array when projections missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const result = await ironflow.listProjections();
      expect(result).toEqual([]);
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 503 })
      );

      await expect(ironflow.listProjections()).rejects.toThrow(
        "List projections failed: 503"
      );
    });

    it("includes environment header", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        environment: "production",
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ projections: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.listProjections();

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["X-Ironflow-Environment"]).toBe("production");
    });
  });

  // --------------------------------------------------------------------------
  // Time-Travel Debugging
  // --------------------------------------------------------------------------

  describe("time-travel debugging", () => {
    // ========================================================================
    // getRunStateAt
    // ========================================================================

    describe("getRunStateAt", () => {
      it("returns decoded snapshot with all fields", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        const inputData = { orderId: "ord-1", amount: 99.99 };
        const stepOutput = { processed: true };
        const stepError = { message: "timeout" };
        const stepOriginalOutput = { processed: false };

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              snapshot: {
                runId: "run-tt-1",
                functionId: "process-order",
                status: "completed",
                input: btoa(JSON.stringify(inputData)),
                steps: [
                  {
                    stepId: "step-1",
                    name: "validate",
                    type: "run",
                    sequence: 1,
                    status: "completed",
                    output: btoa(JSON.stringify(stepOutput)),
                    error: btoa(JSON.stringify(stepError)),
                    originalOutput: btoa(JSON.stringify(stepOriginalOutput)),
                    startedAt: "2026-01-15T10:00:00Z",
                    completedAt: "2026-01-15T10:00:05Z",
                    durationMs: 5000,
                    injected: false,
                    patched: true,
                  },
                ],
                timestamp: "2026-01-15T10:00:10Z",
                createdAt: "2026-01-15T09:59:00Z",
              },
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const result = await ironflow.getRunStateAt(
          "run-tt-1",
          new Date("2026-01-15T10:00:10Z")
        );

        expect(result.runId).toBe("run-tt-1");
        expect(result.functionId).toBe("process-order");
        expect(result.status).toBe("completed");
        expect(result.input).toEqual(inputData);
        expect(result.steps).toHaveLength(1);

        const step = assertDefined(result.steps[0]);
        expect(step.stepId).toBe("step-1");
        expect(step.name).toBe("validate");
        expect(step.type).toBe("run");
        expect(step.sequence).toBe(1);
        expect(step.status).toBe("completed");
        expect(step.output).toEqual(stepOutput);
        expect(step.error).toEqual(stepError);
        expect(step.originalOutput).toEqual(stepOriginalOutput);
        expect(step.durationMs).toBe(5000);
        expect(step.injected).toBe(false);
        expect(step.patched).toBe(true);
      });

      it("decodes base64 input, output, error, and originalOutput via atob", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        const input = { key: "value" };
        const output = { result: 42 };
        const error = { code: "STEP_ERR" };
        const originalOutput = { result: 0 };

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                snapshot: {
                  runId: "run-b64",
                  functionId: "fn-b64",
                  status: "running",
                  input: btoa(JSON.stringify(input)),
                  steps: [
                    {
                      stepId: "s1",
                      name: "step-a",
                      type: "run",
                      sequence: 0,
                      status: "completed",
                      output: btoa(JSON.stringify(output)),
                      error: btoa(JSON.stringify(error)),
                      originalOutput: btoa(JSON.stringify(originalOutput)),
                      startedAt: "2026-01-01T00:00:00Z",
                      completedAt: "2026-01-01T00:00:01Z",
                      durationMs: 1000,
                      injected: false,
                      patched: false,
                    },
                  ],
                  timestamp: "2026-01-01T00:00:02Z",
                  createdAt: "2026-01-01T00:00:00Z",
                },
              }),
          })
        );

        const result = await ironflow.getRunStateAt(
          "run-b64",
          new Date("2026-01-01T00:00:02Z")
        );

        expect(result.input).toEqual(input);
        expect(assertDefined(result.steps[0]).output).toEqual(output);
        expect(assertDefined(result.steps[0]).error).toEqual(error);
        expect(assertDefined(result.steps[0]).originalOutput).toEqual(originalOutput);
      });

      it("handles null/empty optional fields gracefully", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                snapshot: {
                  runId: "run-empty",
                  functionId: "fn-empty",
                  status: "running",
                  input: "",
                  steps: [
                    {
                      stepId: "s1",
                      name: "step-a",
                      type: "run",
                      sequence: 0,
                      status: "running",
                      output: "",
                      error: "",
                      originalOutput: "",
                      startedAt: "",
                      completedAt: "",
                      durationMs: undefined,
                      injected: false,
                      patched: false,
                    },
                  ],
                  timestamp: "2026-01-01T00:00:00Z",
                  createdAt: "",
                },
              }),
          })
        );

        const result = await ironflow.getRunStateAt(
          "run-empty",
          new Date("2026-01-01T00:00:00Z")
        );

        expect(result.input).toBeNull();
        expect(assertDefined(result.steps[0]).output).toBeNull();
        expect(assertDefined(result.steps[0]).error).toBeNull();
        expect(assertDefined(result.steps[0]).originalOutput).toBeNull();
        expect(assertDefined(result.steps[0]).startedAt).toBeNull();
        expect(assertDefined(result.steps[0]).completedAt).toBeNull();
        expect(assertDefined(result.steps[0]).durationMs).toBeNull();
        expect(result.createdAt).toBeNull();
      });

      it("converts timestamp, createdAt, startedAt, completedAt to Date objects", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                snapshot: {
                  runId: "run-dates",
                  functionId: "fn-dates",
                  status: "completed",
                  input: "",
                  steps: [
                    {
                      stepId: "s1",
                      name: "step-a",
                      type: "run",
                      sequence: 0,
                      status: "completed",
                      output: "",
                      error: "",
                      originalOutput: "",
                      startedAt: "2026-06-15T08:30:00Z",
                      completedAt: "2026-06-15T08:30:05Z",
                      durationMs: 5000,
                      injected: false,
                      patched: false,
                    },
                  ],
                  timestamp: "2026-06-15T08:30:10Z",
                  createdAt: "2026-06-15T08:29:00Z",
                },
              }),
          })
        );

        const result = await ironflow.getRunStateAt(
          "run-dates",
          new Date("2026-06-15T08:30:10Z")
        );

        expect(result.timestamp).toBeInstanceOf(Date);
        expect(result.timestamp.toISOString()).toBe("2026-06-15T08:30:10.000Z");
        expect(result.createdAt).toBeInstanceOf(Date);
        expect(result.createdAt!.toISOString()).toBe("2026-06-15T08:29:00.000Z");
        expect(assertDefined(result.steps[0]).startedAt).toBeInstanceOf(Date);
        expect(assertDefined(result.steps[0]).startedAt!.toISOString()).toBe(
          "2026-06-15T08:30:00.000Z"
        );
        expect(assertDefined(result.steps[0]).completedAt).toBeInstanceOf(Date);
        expect(assertDefined(result.steps[0]).completedAt!.toISOString()).toBe(
          "2026-06-15T08:30:05.000Z"
        );
      });

      it("throws IronflowError when response is not ok", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: () =>
              Promise.resolve(
                JSON.stringify({ message: "Run not found", code: "NOT_FOUND" })
              ),
          })
        );

        await expect(
          ironflow.getRunStateAt("run-missing", new Date())
        ).rejects.toThrow("Run not found");
      });

      it("throws with fallback message when error body has no message", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve("not json"),
          })
        );

        await expect(
          ironflow.getRunStateAt("run-x", new Date())
        ).rejects.toThrow("Get run state failed: 500");
      });

      it("throws NotConfiguredError when called before configure", async () => {
        await expect(
          ironflow.getRunStateAt("run-1", new Date())
        ).rejects.toThrow("Client not configured");
      });

      it("propagates network errors from fetch", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
        );

        await expect(
          ironflow.getRunStateAt("run-net", new Date())
        ).rejects.toThrow("Failed to fetch");
      });

      it("sends correct URL, method, headers, and body", async () => {
        ironflow.configure({
          serverUrl: "http://localhost:9123",
          environment: "staging",
          auth: { apiKey: "key-123" },
          logger: false,
        });
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              snapshot: {
                runId: "run-req",
                functionId: "fn-req",
                status: "completed",
                input: "",
                steps: [],
                timestamp: "2026-01-01T00:00:00Z",
                createdAt: "2026-01-01T00:00:00Z",
              },
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const ts = new Date("2026-03-01T12:00:00Z");
        await ironflow.getRunStateAt("run-req", ts);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
        expect(url).toBe(
          "http://localhost:9123/ironflow.v1.TimeTravelService/GetRunStateAt"
        );
        expect(opts.method).toBe("POST");
        expect(opts.headers["Content-Type"]).toBe("application/json");
        expect(opts.headers["Authorization"]).toBe("Bearer key-123");
        expect(opts.headers["X-Ironflow-Environment"]).toBe("staging");

        const body = JSON.parse(opts.body);
        expect(body.runId).toBe("run-req");
        expect(body.timestamp).toBe("2026-03-01T12:00:00.000Z");
      });

      it("handles empty steps array", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                snapshot: {
                  runId: "run-no-steps",
                  functionId: "fn-no-steps",
                  status: "running",
                  input: "",
                  steps: [],
                  timestamp: "2026-01-01T00:00:00Z",
                  createdAt: "2026-01-01T00:00:00Z",
                },
              }),
          })
        );

        const result = await ironflow.getRunStateAt(
          "run-no-steps",
          new Date("2026-01-01T00:00:00Z")
        );

        expect(result.steps).toEqual([]);
      });
    });

    // ========================================================================
    // getRunTimeline
    // ========================================================================

    describe("getRunTimeline", () => {
      it("returns mapped events array with all fields", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "evt-1",
                  eventType: "step.completed",
                  stepId: "step-a",
                  stepName: "validate",
                  summary: "Step validate completed",
                  significant: true,
                  timestamp: "2026-01-15T10:00:00Z",
                },
                {
                  id: "evt-2",
                  eventType: "step.started",
                  stepId: "step-b",
                  stepName: "process",
                  summary: "Step process started",
                  significant: false,
                  timestamp: "2026-01-15T10:00:05Z",
                },
              ],
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const result = await ironflow.getRunTimeline("run-tl-1");

        expect(result).toHaveLength(2);
        const e0 = assertDefined(result[0]);
        const e1 = assertDefined(result[1]);

        expect(e0.id).toBe("evt-1");
        expect(e0.eventType).toBe("step.completed");
        expect(e0.stepId).toBe("step-a");
        expect(e0.stepName).toBe("validate");
        expect(e0.summary).toBe("Step validate completed");
        expect(e0.significant).toBe(true);
        expect(e0.timestamp).toBeInstanceOf(Date);

        expect(e1.id).toBe("evt-2");
        expect(e1.eventType).toBe("step.started");
        expect(e1.stepId).toBe("step-b");
        expect(e1.stepName).toBe("process");
        expect(e1.summary).toBe("Step process started");
        expect(e1.significant).toBe(false);
      });

      it("converts timestamp field to Date objects", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    id: "evt-d",
                    eventType: "run.started",
                    stepId: "",
                    stepName: "",
                    summary: "Run started",
                    significant: true,
                    timestamp: "2026-07-20T14:30:00Z",
                  },
                ],
              }),
          })
        );

        const result = await ironflow.getRunTimeline("run-tl-date");

        const e0 = assertDefined(result[0]);
        expect(e0.timestamp).toBeInstanceOf(Date);
        expect(e0.timestamp.toISOString()).toBe(
          "2026-07-20T14:30:00.000Z"
        );
      });

      it("returns empty array when events are empty", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ events: [] }),
          })
        );

        const result = await ironflow.getRunTimeline("run-tl-empty");
        expect(result).toEqual([]);
      });

      it("returns empty array when events field is missing", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({}),
          })
        );

        const result = await ironflow.getRunTimeline("run-tl-no-events");
        expect(result).toEqual([]);
      });

      it("throws IronflowError when response is not ok", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  message: "Internal error",
                  code: "INTERNAL",
                })
              ),
          })
        );

        await expect(ironflow.getRunTimeline("run-tl-err")).rejects.toThrow(
          "Internal error"
        );
      });

      it("throws with fallback message when error body has no message", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            text: () => Promise.resolve("Service Unavailable"),
          })
        );

        await expect(
          ironflow.getRunTimeline("run-tl-bad")
        ).rejects.toThrow("Get run timeline failed: 503");
      });

      it("preserves significant boolean flag", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    id: "evt-sig-t",
                    eventType: "step.completed",
                    stepId: "s1",
                    stepName: "s1",
                    summary: "significant event",
                    significant: true,
                    timestamp: "2026-01-01T00:00:00Z",
                  },
                  {
                    id: "evt-sig-f",
                    eventType: "step.started",
                    stepId: "s2",
                    stepName: "s2",
                    summary: "non-significant event",
                    significant: false,
                    timestamp: "2026-01-01T00:00:01Z",
                  },
                ],
              }),
          })
        );

        const result = await ironflow.getRunTimeline("run-tl-sig");

        expect(assertDefined(result[0]).significant).toBe(true);
        expect(assertDefined(result[1]).significant).toBe(false);
      });

      it("sends correct URL, method, and body", async () => {
        ironflow.configure({
          serverUrl: "http://localhost:9123",
          environment: "production",
          auth: { apiKey: "key-tl" },
          logger: false,
        });
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ events: [] }),
        });
        vi.stubGlobal("fetch", mockFetch);

        await ironflow.getRunTimeline("run-tl-req");

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
        expect(url).toBe(
          "http://localhost:9123/ironflow.v1.TimeTravelService/GetRunTimeline"
        );
        expect(opts.method).toBe("POST");
        expect(opts.headers["Content-Type"]).toBe("application/json");
        expect(opts.headers["Authorization"]).toBe("Bearer key-tl");
        expect(opts.headers["X-Ironflow-Environment"]).toBe("production");

        const body = JSON.parse(opts.body);
        expect(body.runId).toBe("run-tl-req");
      });

      it("defaults missing stepId and stepName to empty string", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    id: "evt-no-step",
                    eventType: "run.completed",
                    summary: "Run completed",
                    significant: true,
                    timestamp: "2026-01-01T00:00:00Z",
                  },
                ],
              }),
          })
        );

        const result = await ironflow.getRunTimeline("run-tl-nostep");

        const r0 = assertDefined(result[0]);
        expect(r0.stepId).toBe("");
        expect(r0.stepName).toBe("");
      });
    });

    // ========================================================================
    // getStepOutputAt
    // ========================================================================

    describe("getStepOutputAt", () => {
      it("returns decoded step output snapshot", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        const outputData = { count: 42, items: ["a", "b"] };
        const originalData = { count: 0, items: [] };

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              stepId: "step-out-1",
              status: "completed",
              output: btoa(JSON.stringify(outputData)),
              originalOutput: btoa(JSON.stringify(originalData)),
              patched: true,
              injected: false,
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const result = await ironflow.getStepOutputAt(
          "run-so-1",
          "step-out-1",
          new Date("2026-01-15T10:00:00Z")
        );

        expect(result.stepId).toBe("step-out-1");
        expect(result.status).toBe("completed");
        expect(result.output).toEqual(outputData);
        expect(result.originalOutput).toEqual(originalData);
        expect(result.patched).toBe(true);
        expect(result.injected).toBe(false);
      });

      it("decodes base64 output and originalOutput via atob", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        const output = { decoded: true, value: "hello" };
        const original = { decoded: true, value: "world" };

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                stepId: "s-b64",
                status: "completed",
                output: btoa(JSON.stringify(output)),
                originalOutput: btoa(JSON.stringify(original)),
                patched: false,
                injected: false,
              }),
          })
        );

        const result = await ironflow.getStepOutputAt(
          "run-b64",
          "s-b64",
          new Date()
        );

        expect(result.output).toEqual(output);
        expect(result.originalOutput).toEqual(original);
      });

      it("handles null originalOutput when field is empty", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                stepId: "s-no-orig",
                status: "completed",
                output: btoa(JSON.stringify({ result: "ok" })),
                originalOutput: "",
                patched: false,
                injected: false,
              }),
          })
        );

        const result = await ironflow.getStepOutputAt(
          "run-no-orig",
          "s-no-orig",
          new Date()
        );

        expect(result.output).toEqual({ result: "ok" });
        expect(result.originalOutput).toBeNull();
      });

      it("handles null output when field is empty", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                stepId: "s-no-out",
                status: "running",
                output: "",
                originalOutput: "",
                patched: false,
                injected: false,
              }),
          })
        );

        const result = await ironflow.getStepOutputAt(
          "run-no-out",
          "s-no-out",
          new Date()
        );

        expect(result.output).toBeNull();
        expect(result.originalOutput).toBeNull();
      });

      it("throws IronflowError when response is not ok", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  message: "Step not found",
                  code: "NOT_FOUND",
                })
              ),
          })
        );

        await expect(
          ironflow.getStepOutputAt("run-so-err", "step-missing", new Date())
        ).rejects.toThrow("Step not found");
      });

      it("throws with fallback message when error body has no message", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve("server error text"),
          })
        );

        await expect(
          ironflow.getStepOutputAt("run-so-bad", "step-bad", new Date())
        ).rejects.toThrow("Get step output failed: 500");
      });

      it("preserves patched and injected boolean flags", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                stepId: "s-flags",
                status: "completed",
                output: btoa(JSON.stringify({ x: 1 })),
                originalOutput: btoa(JSON.stringify({ x: 0 })),
                patched: true,
                injected: true,
              }),
          })
        );

        const result = await ironflow.getStepOutputAt(
          "run-flags",
          "s-flags",
          new Date()
        );

        expect(result.patched).toBe(true);
        expect(result.injected).toBe(true);
      });

      it("sends correct URL, method, headers, and body", async () => {
        ironflow.configure({
          serverUrl: "http://localhost:9123",
          environment: "staging",
          auth: { apiKey: "key-so" },
          logger: false,
        });
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              stepId: "step-req",
              status: "completed",
              output: btoa(JSON.stringify({})),
              originalOutput: "",
              patched: false,
              injected: false,
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const ts = new Date("2026-05-01T08:00:00Z");
        await ironflow.getStepOutputAt("run-so-req", "step-req", ts);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
        expect(url).toBe(
          "http://localhost:9123/ironflow.v1.TimeTravelService/GetStepOutputAt"
        );
        expect(opts.method).toBe("POST");
        expect(opts.headers["Content-Type"]).toBe("application/json");
        expect(opts.headers["Authorization"]).toBe("Bearer key-so");
        expect(opts.headers["X-Ironflow-Environment"]).toBe("staging");

        const body = JSON.parse(opts.body);
        expect(body.runId).toBe("run-so-req");
        expect(body.stepId).toBe("step-req");
        expect(body.timestamp).toBe("2026-05-01T08:00:00.000Z");
      });

      it("handles false patched and injected flags", async () => {
        ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
              Promise.resolve({
                stepId: "s-no-flags",
                status: "completed",
                output: btoa(JSON.stringify({ val: 1 })),
                originalOutput: "",
                patched: false,
                injected: false,
              }),
          })
        );

        const result = await ironflow.getStepOutputAt(
          "run-no-flags",
          "s-no-flags",
          new Date()
        );

        expect(result.patched).toBe(false);
        expect(result.injected).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // schemas sub-client
  // --------------------------------------------------------------------------

  describe("schemas.register", () => {
    it("POSTs to /api/v1/events/schemas and returns schema", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              event_name: "order.placed",
              version: 1,
              schema_json: JSON.stringify({ type: "object" }),
              created_at: "2026-03-28T00:00:00Z",
            }),
        })
      );

      const result = await ironflow.schemas.register({
        name: "order.placed",
        version: 1,
        schema: { type: "object" },
      });

      expect(result.event_name).toBe("order.placed");
      expect(result.version).toBe(1);
      expect(result.created_at).toBe("2026-03-28T00:00:00Z");
      const [url, opts] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/schemas");
      expect(opts?.method).toBe("POST");
    });

    it("throws on 500", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve('{"message":"internal error"}'),
        })
      );

      await expect(
        ironflow.schemas.register({ name: "x", version: 1, schema: {} })
      ).rejects.toThrow();
    });
  });

  describe("schemas.list", () => {
    it("GETs /api/v1/events/schemas and returns array", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              schemas: [
                { event_name: "order.placed", version: 1, schema_json: "{}", created_at: "2026-03-28T00:00:00Z" },
                { event_name: "order.placed", version: 2, schema_json: "{}", created_at: "2026-03-29T00:00:00Z" },
              ],
            }),
        })
      );

      const result = await ironflow.schemas.list();

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).event_name).toBe("order.placed");
      expect(assertDefined(result[1]).version).toBe(2);
      const [url, opts] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/schemas");
      expect(opts?.method).toBe("GET");
    });

    it("returns empty array when schemas key is absent", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );

      const result = await ironflow.schemas.list();
      expect(result).toEqual([]);
    });
  });

  describe("schemas.get", () => {
    it("GETs /api/v1/events/schemas/:name and returns schema", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              event_name: "order.placed",
              version: 2,
              schema_json: JSON.stringify({ type: "object" }),
              created_at: "2026-03-28T00:00:00Z",
            }),
        })
      );

      const result = await ironflow.schemas.get("order.placed");

      expect(result.event_name).toBe("order.placed");
      expect(result.version).toBe(2);
      const [url] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/schemas/order.placed");
    });

    it("throws on 404", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () => Promise.resolve('{"message":"schema not found"}'),
        })
      );

      await expect(ironflow.schemas.get("nonexistent")).rejects.toThrow("schema not found");
    });
  });

  describe("schemas.getVersion", () => {
    it("GETs /api/v1/events/schemas/:name/:version and returns schema", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              event_name: "order.placed",
              version: 1,
              schema_json: JSON.stringify({ type: "object" }),
              created_at: "2026-03-28T00:00:00Z",
            }),
        })
      );

      const result = await ironflow.schemas.getVersion("order.placed", 1);

      expect(result.version).toBe(1);
      const [url] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/schemas/order.placed/1");
    });
  });

  describe("schemas.delete", () => {
    it("DELETEs /api/v1/events/schemas/:name/:version", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 204,
        })
      );

      await ironflow.schemas.delete("order.placed", 1);

      const [url, opts] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/schemas/order.placed/1");
      expect(opts?.method).toBe("DELETE");
    });

    it("throws on 404", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () => Promise.resolve('{"message":"schema not found"}'),
        })
      );

      await expect(ironflow.schemas.delete("nonexistent", 1)).rejects.toThrow("schema not found");
    });
  });

  describe("schemas.testUpcast", () => {
    it("POSTs to /api/v1/events/upcast and returns result", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: { orderId: "123", totalV2: 99.99 },
            }),
        })
      );

      const result = await ironflow.schemas.testUpcast({
        eventName: "order.placed",
        fromVersion: 1,
        toVersion: 2,
        data: { orderId: "123", total: 99.99 },
      });

      expect(result.success).toBe(true);
      const [url, opts] = assertDefined(vi.mocked(fetch).mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/events/upcast");
      expect(opts?.method).toBe("POST");
      const body = JSON.parse(opts?.body as string);
      expect(body.eventName).toBe("order.placed");
      expect(body.fromVersion).toBe(1);
      expect(body.toVersion).toBe(2);
    });

    it("returns failure result with error message", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              success: false,
              error: "no upcaster registered",
            }),
        })
      );

      const result = await ironflow.schemas.testUpcast({
        eventName: "order.placed",
        fromVersion: 1,
        toVersion: 3,
        data: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("no upcaster registered");
    });

    it("throws on server error", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve('{"message":"internal error"}'),
        })
      );

      await expect(
        ironflow.schemas.testUpcast({ eventName: "x", fromVersion: 1, toVersion: 2, data: {} })
      ).rejects.toThrow();
    });
  });

  describe("getAuditTrail", () => {
    it("returns parsed audit trail result", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "ae-1",
                  run_id: "run-123",
                  function_id: "fn-1",
                  event_type: "step.completed",
                  payload: { stepId: "s1" },
                  created_at: "2026-03-28T00:00:00Z",
                },
              ],
              total_count: 1,
              next_cursor: "cursor-next",
            }),
        })
      );

      const result = await ironflow.getAuditTrail("run-123");

      expect(result.events).toHaveLength(1);
      const ev0 = assertDefined(result.events[0]);
      expect(ev0.id).toBe("ae-1");
      expect(ev0.runId).toBe("run-123");
      expect(ev0.eventType).toBe("step.completed");
      expect(result.totalCount).toBe(1);
      expect(result.nextCursor).toBe("cursor-next");
    });

    it("returns empty events on empty response", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ total_count: 0 }),
        })
      );

      const result = await ironflow.getAuditTrail("run-123");

      expect(result.events).toEqual([]);
      expect(result.totalCount).toBe(0);
    });
  });

  describe("webhooks", () => {
    it("lists webhook sources", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sources: [
                {
                  id: "stripe",
                  event_prefix: "stripe.",
                  source_type: "api",
                },
              ],
            }),
        })
      );

      const sources = await ironflow.webhooks.listSources();

      expect(sources).toHaveLength(1);
      const s0 = assertDefined(sources[0]);
      expect(s0.id).toBe("stripe");
      expect(s0.eventPrefix).toBe("stripe.");
    });

    it("deletes a webhook source", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.webhooks.deleteSource("stripe");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/DeleteWebhookSource",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ id: "stripe" }),
        })
      );
    });

    it("lists webhook deliveries", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              deliveries: [
                { id: "del-1", source_id: "stripe", status: "delivered" },
              ],
              total_count: 1,
            }),
        })
      );

      const result = await ironflow.webhooks.listDeliveries({ sourceId: "stripe" });

      expect(result.deliveries).toHaveLength(1);
      expect(assertDefined(result.deliveries[0]).sourceId).toBe("stripe");
      expect(result.totalCount).toBe(1);
    });

    // ── Source management (#1526) ─────────────────────────────────────────────

    const okJson = (body: unknown) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(body),
      });
      vi.stubGlobal("fetch", mockFetch);
      return mockFetch;
    };
    const sentBody = (mockFetch: ReturnType<typeof vi.fn>) =>
      JSON.parse(assertDefined(mockFetch.mock.calls[0])[1].body);

    it("sends name (not id) on create and surfaces the write-once token", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = okJson({
        id: "wh_1",
        name: "Stripe",
        event_prefix: "stripe.",
        ingest_token: "ifwh_rawsecret",
      });

      const source = await ironflow.webhooks.create({
        name: "Stripe",
        eventPrefix: "stripe.",
      });

      const body = sentBody(mockFetch);
      expect(body.name).toBe("Stripe");
      expect(body).not.toHaveProperty("id");
      expect(source.ingestToken).toBe("ifwh_rawsecret");
    });

    it("fetches a single source with the secret-state flags", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = okJson({
        id: "wh_1",
        name: "Stripe",
        event_prefix: "stripe.",
        verify_secret_set: true,
        verify_secret_prev_set: true,
        verify_secret_prev_expires_at: "2026-03-29T00:00:00Z",
      });

      const source = await ironflow.webhooks.getSource("wh_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/GetWebhookSource",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "wh_1" }) })
      );
      expect(source.verifySecretSet).toBe(true);
      expect(source.verifySecretPrevSet).toBe(true);
      expect(source.verifySecretPrevExpiresAt).toBe("2026-03-29T00:00:00Z");
    });

    it("sends the concurrency token on update", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = okJson({ id: "wh_1", name: "renamed", event_prefix: "stripe." });

      await ironflow.webhooks.updateSource({
        id: "wh_1",
        name: "renamed",
        expectedUpdatedAt: "2026-03-28T00:00:00Z",
      });

      expect(sentBody(mockFetch).expected_updated_at).toBe("2026-03-28T00:00:00Z");
      // Preserve-on-omit only works while the key is absent entirely.
      expect(sentBody(mockFetch)).not.toHaveProperty("verify_config");
    });

    it("treats graceSeconds as tri-state", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const response = { id: "wh_1", name: "Stripe", event_prefix: "stripe." };

      // Omitted → absent key, so the server's configured default wins.
      let mockFetch = okJson(response);
      await ironflow.webhooks.rotateSecret({ id: "wh_1", verifySecret: "whsec_new" });
      expect(sentBody(mockFetch)).not.toHaveProperty("grace_seconds");

      // 0 → instant cutover, which a truthiness check would collapse into
      // "server default" and leave the old secret verifying for 24 h.
      mockFetch = okJson(response);
      await ironflow.webhooks.rotateSecret({ id: "wh_1", verifySecret: "whsec_new", graceSeconds: 0 });
      expect(sentBody(mockFetch).grace_seconds).toBe(0);

      mockFetch = okJson(response);
      await ironflow.webhooks.disableSignatureVerification({ id: "wh_1", graceSeconds: 0 });
      expect(sentBody(mockFetch).grace_seconds).toBe(0);
    });

    it("expires the previous secret slot and rotates the ingest token", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });

      let mockFetch = okJson({ id: "wh_1", name: "Stripe", event_prefix: "stripe." });
      await ironflow.webhooks.expireSecretPrev("wh_1");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/ExpireWebhookSecretPrev",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "wh_1" }) })
      );

      mockFetch = okJson({ id: "wh_1", name: "Stripe", event_prefix: "stripe.", ingest_token: "ifwh_new" });
      const rotated = await ironflow.webhooks.rotateIngestToken("wh_1", "2026-03-28T00:00:00Z");
      expect(sentBody(mockFetch).expected_updated_at).toBe("2026-03-28T00:00:00Z");
      expect(rotated.ingestToken).toBe("ifwh_new");
    });
  });

  describe("remaining parity wrappers", () => {
    it("lists streams and maps entity history", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ streams: [{ entity_id: "order-1", entity_type: "order", version: 2, event_count: 2, updated_at: "now" }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ entries: [{ event_name: "order.placed", event_data: { total: 10 }, entity_version: 1, timestamp: "now" }] }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const streams = await ironflow.streams.listStreams();
      const history = await ironflow.streams.getEntityHistory("order-1");
      expect(streams[0]?.entityId).toBe("order-1");
      expect(history[0]?.eventName).toBe("order.placed");
      expect(history[0]?.version).toBe(1);
    });

    it("manages consumer groups and rejects an empty update", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: "orders", namespace: "default", pattern: "order.*" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const group = await ironflow.consumerGroups.create({ name: "orders", pattern: "order.*" });
      expect(group.name).toBe("orders");
      await expect(ironflow.consumerGroups.update("orders", {})).rejects.toThrow(
        "Consumer group update requires at least one field"
      );
      await ironflow.consumerGroups.update("orders", { pattern: "order.>" });
      const updateBody = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
      expect(updateBody.update_mask.paths).toEqual(["pattern"]);
    });

    it("queries environment audit events", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          events: [{ id: "a1", run_id: "run-1", function_id: "fn-1", event_type: "run.completed", payload: {}, created_at: "now" }],
          total_count: 1,
          next_cursor: "next",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.listAuditEvents({ functionId: "fn-1", limit: 10 });
      expect(result.events[0]?.functionId).toBe("fn-1");
      expect(result.nextCursor).toBe("next");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/audit?function_id=fn-1&limit=10"),
        expect.objectContaining({ method: "GET" })
      );
    });

    it("lists role policies", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ policies: [{ id: "p1" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const policies = await ironflow.roles.listPolicies("role/1");
      expect(policies[0]?.id).toBe("p1");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/roles/role%2F1/policies"),
        expect.objectContaining({ method: "GET" })
      );
    });

  });

  describe("tenants", () => {
    it("lists tenants", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: "org_acme", name: "Acme Corp", env_count: 2, key_count: 3 },
            ]),
        })
      );

      const tenants = await ironflow.tenants.list();

      expect(tenants).toHaveLength(1);
      const t0 = assertDefined(tenants[0]);
      expect(t0.id).toBe("org_acme");
      expect(t0.name).toBe("Acme Corp");
    });

    it("throws EnterpriseRequiredError on 402", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 402,
          text: () => Promise.resolve(JSON.stringify({ message: "enterprise license required" })),
        })
      );

      await expect(ironflow.tenants.list()).rejects.toThrow("enterprise license required");
    });

    it("provisions a tenant", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({
          org: { id: "org-acme", name: "Acme" },
          environment: { id: "env-prod", name: "production" },
          api_key: { key: "ifkey_secret", roles: ["admin"] },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.tenants.provision({ orgName: "Acme" });
      expect(result.apiKey.key).toBe("ifkey_secret");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/tenants/provision"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});
