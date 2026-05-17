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

describe("resumeRun behavior", () => {
  it("should POST to /api/v1/runs/resume with correct body", async () => {
    const originalFetch = global.fetch;
    const mockResponse = { id: "run-1", status: "running" };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    global.fetch = mockFetch;

    const serverUrl = "http://localhost:9123";
    const runId = "run-1";
    const fromStep = "step-3";

    async function resumeRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/api/v1/runs/resume`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, from_step: fromStep || "" }),
      });
      if (!response.ok) {
        throw new Error(`Resume run failed: ${response.status}`);
      }
      return response.json();
    }

    const result = await resumeRun(serverUrl, runId, fromStep);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    const opts = assertDefined(options);
    expect(url).toBe("http://localhost:9123/api/v1/runs/resume");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body as string);
    expect(body.run_id).toBe("run-1");
    expect(body.from_step).toBe("step-3");
    expect(result).toEqual(mockResponse);

    global.fetch = originalFetch;
  });

  it("should default from_step to empty string when not provided", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1" }),
    });
    global.fetch = mockFetch;

    async function resumeRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/api/v1/runs/resume`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, from_step: fromStep || "" }),
      });
      if (!response.ok) {
        throw new Error(`Resume run failed: ${response.status}`);
      }
      return response.json();
    }

    await resumeRun("http://localhost:9123", "run-2");

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.from_step).toBe("");

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"message":"internal error"}'),
    });

    async function resumeRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/api/v1/runs/resume`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, from_step: fromStep || "" }),
      });
      if (!response.ok) {
        throw new Error(`Resume run failed: ${response.status}`);
      }
      return response.json();
    }

    await expect(
      resumeRun("http://localhost:9123", "run-fail")
    ).rejects.toThrow("Resume run failed: 500");

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

describe("retryRun behavior", () => {
  it("should POST to ConnectRPC endpoint /ironflow.v1.IronflowService/RetryRun", async () => {
    const originalFetch = global.fetch;
    const mockResponse = {
      id: "run-1",
      functionId: "fn-1",
      eventId: "evt-1",
      status: "RUNNING",
      attempt: 2,
      maxAttempts: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });
    global.fetch = mockFetch;

    async function retryRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.IronflowService/RetryRun`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, fromStep }),
      });
      if (!response.ok) {
        throw new Error(`Retry run failed: ${response.status}`);
      }
      const text = await response.text();
      return JSON.parse(text);
    }

    const result = await retryRun("http://localhost:9123", "run-1", "step-2");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = assertDefined(mockFetch.mock.calls[0]);
    expect(url).toBe("http://localhost:9123/ironflow.v1.IronflowService/RetryRun");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(options.body);
    expect(body.id).toBe("run-1");
    expect(body.fromStep).toBe("step-2");
    expect(result).toEqual(mockResponse);

    global.fetch = originalFetch;
  });

  it("should work without fromStep parameter", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            id: "run-2",
            functionId: "fn-1",
            eventId: "evt-2",
            status: "RUNNING",
            attempt: 2,
            maxAttempts: 3,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:01Z",
          })
        ),
    });
    global.fetch = mockFetch;

    async function retryRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.IronflowService/RetryRun`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, fromStep }),
      });
      if (!response.ok) {
        throw new Error(`Retry run failed: ${response.status}`);
      }
      const text = await response.text();
      return JSON.parse(text);
    }

    await retryRun("http://localhost:9123", "run-2");

    const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
    expect(body.id).toBe("run-2");
    expect(body.fromStep).toBeUndefined();

    global.fetch = originalFetch;
  });

  it("should throw when response is not ok", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"run not found"}'),
    });

    async function retryRun(
      serverUrl: string,
      runId: string,
      fromStep?: string
    ): Promise<unknown> {
      const url = `${serverUrl}/ironflow.v1.IronflowService/RetryRun`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, fromStep }),
      });
      if (!response.ok) {
        throw new Error(`Retry run failed: ${response.status}`);
      }
      const text = await response.text();
      return JSON.parse(text);
    }

    await expect(
      retryRun("http://localhost:9123", "run-missing")
    ).rejects.toThrow("Retry run failed: 404");

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

    it("retryRun throws NotConfiguredError", async () => {
      await expect(ironflow.retryRun("run-1")).rejects.toThrow(
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

    it("rebuildProjection throws NotConfiguredError", async () => {
      await expect(
        ironflow.rebuildProjection("order-stats")
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
    it("sends correct ConnectRPC request and returns result", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ runIds: ["run_1"], eventId: "evt_1" })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.invoke("my-fn", {
        data: { key: "value" },
      });

      expect(result.runIds).toEqual(["run_1"]);
      expect(result.eventId).toBe("evt_1");

      // Verify fetch was called with correct URL and body
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/ironflow.v1.IronflowService/Trigger"
      );
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.event).toBe("my-fn");
      expect(body.data).toEqual({ key: "value" });
    });

    it("defaults runIds to empty array when missing", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ eventId: "evt_2" })),
        })
      );

      const result = await ironflow.invoke("fn-2", { data: {} });
      expect(result.runIds).toEqual([]);
      expect(result.eventId).toBe("evt_2");
    });

    it("includes auth header when apiKey is configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "test-key-123" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ eventId: "evt_3", runIds: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("fn-3", { data: {} });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer test-key-123");
    });

    it("includes auth header when token is configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { token: "jwt-token-456" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ eventId: "evt_4", runIds: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("fn-4", { data: {} });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer jwt-token-456");
    });

    it("includes environment header", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        environment: "staging",
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ eventId: "evt_5", runIds: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.invoke("fn-5", { data: {} });

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["X-Ironflow-Environment"]).toBe("staging");
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

    it("normalizes lowercase status without prefix", async () => {
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

      const run = await ironflow.getRun("run_4");
      expect(run.status).toBe("cancelled");
    });

    it("falls back to failed for unknown status", async () => {
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

      const run = await ironflow.getRun("run_5");
      expect(run.status).toBe("failed");
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
                status: "completed",
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
                status: "pending",
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
      expect(body.status).toBe("COMPLETED");
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
  // retryRun
  // --------------------------------------------------------------------------

  describe("retryRun", () => {
    it("sends retry request with fromStep and returns normalized run", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: "run_r",
              functionId: "fn-r",
              eventId: "evt-r",
              status: "RUN_STATUS_RUNNING",
              attempt: 2,
              maxAttempts: 3,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:03:00Z",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const run = await ironflow.retryRun("run_r", "step-2");

      expect(run.id).toBe("run_r");
      expect(run.status).toBe("running");
      expect(run.attempt).toBe(2);

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.id).toBe("run_r");
      expect(body.fromStep).toBe("step-2");
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
  // emitSync
  // --------------------------------------------------------------------------

  describe("emitSync", () => {
    it("returns EmitSyncResult when run completes successfully", async () => {
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
                  status: "completed",
                  output: { total: 99.99 },
                  durationMs: 42,
                },
              ],
              eventId: "evt_abc",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.emitSync("order.placed", { orderId: "123" });

      expect(result.runId).toBe("run_abc123");
      expect(result.functionId).toBe("my-function");
      expect(result.status).toBe("completed");
      expect(result.output).toEqual({ total: 99.99 });
      expect(result.durationMs).toBe(42);

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
                  status: "completed",
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

    it("throws RunFailedError when run status is failed", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_fail",
                  functionId: "my-function",
                  status: "failed",
                  output: null,
                  error: { message: "something broke", code: "STEP_FAILED" },
                  durationMs: 5,
                },
              ],
              eventId: "evt_f",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const err = await ironflow.emitSync("order.placed", {}).catch((e) => e);
      expect(err.constructor.name).toBe("RunFailedError");
      expect(err.runId).toBe("run_fail");
      expect(err.code).toBe("RUN_FAILED");
    });

    it("throws RunCancelledError when run status is cancelled", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                {
                  runId: "run_cancel",
                  functionId: "my-function",
                  status: "cancelled",
                  output: null,
                  durationMs: 0,
                },
              ],
              eventId: "evt_c",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const err = await ironflow.emitSync("order.placed", {}).catch((e) => e);
      expect(err.constructor.name).toBe("RunCancelledError");
      expect(err.runId).toBe("run_cancel");
      expect(err.code).toBe("RUN_CANCELLED");
    });

    it("throws IronflowError when server returns empty results", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ results: [], eventId: "evt_empty" })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(ironflow.emitSync("test.event", {})).rejects.toThrow(
        "No results returned from TriggerSync"
      );
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
  // resumeRun (uses direct fetch, not request() helper)
  // --------------------------------------------------------------------------

  describe("resumeRun", () => {
    it("POSTs to /api/v1/runs/resume with correct body", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "run_re", status: "running" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await ironflow.resumeRun("run_re", "step-3");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/api/v1/runs/resume");
      const body = JSON.parse(opts.body);
      expect(body.run_id).toBe("run_re");
      expect(body.from_step).toBe("step-3");
      expect(result).toEqual({ id: "run_re", status: "running" });
    });

    it("defaults from_step to empty string", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "run_re2" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.resumeRun("run_re2");

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.from_step).toBe("");
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
  // rebuildProjection
  // --------------------------------------------------------------------------

  describe("rebuildProjection", () => {
    it("sends POST request with empty options", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "rebuilding" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.rebuildProjection("order-stats");

      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe(
        "http://localhost:9123/api/v1/projections/order-stats/rebuild"
      );
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends all options in body when provided", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "rebuilding" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.rebuildProjection("order-stats", {
        partition: "customer-1",
        fromEventId: "evt-50",
        dryRun: true,
      });

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0]?.[1]).body as string);
      expect(body.partition).toBe("customer-1");
      expect(body.from_event_id).toBe("evt-50");
      expect(body.dry_run).toBe(true);
    });

    it("returns status from server", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ status: "rebuilding" }),
        })
      );

      const result = await ironflow.rebuildProjection("order-stats");
      expect(result).toEqual({ status: "rebuilding" });
    });

    it("throws IronflowError when response is not ok", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "rebuild already in progress" })
            ),
        })
      );

      await expect(
        ironflow.rebuildProjection("order-stats")
      ).rejects.toThrow("rebuild already in progress");
    });

    it("includes auth header when configured", async () => {
      ironflow.configure({
        serverUrl: "http://localhost:9123",
        auth: { apiKey: "rebuild-key" },
        logger: false,
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "rebuilding" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.rebuildProjection("order-stats");

      const headers = assertDefined(mockFetch.mock.calls[0]?.[1]).headers;
      expect(headers["Authorization"]).toBe("Bearer rebuild-key");
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
  });

  describe("users", () => {
    it("lists users", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: "user-1", email: "alice@example.com", name: "Alice" },
            ]),
        })
      );

      const users = await ironflow.users.list();

      expect(users).toHaveLength(1);
      const u0 = assertDefined(users[0]);
      expect(u0.id).toBe("user-1");
      expect(u0.email).toBe("alice@example.com");
    });

    it("creates a user", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            id: "user-2",
            email: "bob@example.com",
            roles: ["viewer"],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const user = await ironflow.users.create({
        email: "bob@example.com",
        password: "secret",
      });

      expect(user.id).toBe("user-2");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("gets a user by id", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: "user-1", email: "alice@example.com" }),
        })
      );

      const user = await ironflow.users.get("user-1");
      expect(user.id).toBe("user-1");
    });

    it("updates a user", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: "user-1", name: "Alice Smith", email: "alice@example.com" }),
        })
      );

      const user = await ironflow.users.update("user-1", { name: "Alice Smith" });
      expect(user.name).toBe("Alice Smith");
    });

    it("deletes a user", async () => {
      ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      await ironflow.users.delete("user-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users/user-1",
        expect.objectContaining({ method: "DELETE" })
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
  });
});
