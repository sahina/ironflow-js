// Wire-format parity tests for DebounceConfig serialization.
//
// JS SDK uses camelCase (periodMs, maxWaitMs) but the Go server's
// ParseConfig consumes snake_case (period_ms, max_wait_ms). The SDK
// transform lives in two places: client.registerFunction (push-mode
// registration) and worker register (pull-mode registration). Both
// must emit identical wire bodies. Drift between the two — or between
// JS and Go — silently breaks debounced functions at registration
// time.

import { describe, it, expect, vi, afterEach } from "vitest";

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
    RunFailedError: actual.RunFailedError,
    RunCancelledError: actual.RunCancelledError,
    UnauthenticatedError: actual.UnauthenticatedError,
    EnterpriseRequiredError: actual.EnterpriseRequiredError,
    UnauthorizedError: actual.UnauthorizedError,
  };
});

const { createClient } = await import("./client.js");

type WireBody = {
  debounce?: {
    period_ms?: number;
    key?: string;
    max_wait_ms?: number;
  };
};

async function captureRegisterBody(args: {
  debounce: { periodMs: number; key?: string; maxWaitMs?: number };
}): Promise<WireBody> {
  let captured: WireBody = {};
  const mockFetch = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as WireBody;
    return {
      ok: true,
      json: () => Promise.resolve({ created: true }),
    };
  });
  vi.stubGlobal("fetch", mockFetch);

  const client = createClient({ serverUrl: "http://localhost:9123" });
  await client.registerFunction({
    id: "fn-debounce-wire",
    triggers: [{ event: "x" }],
    endpointUrl: "http://localhost:3000/api/ironflow",
    preferredMode: "push",
    debounce: args.debounce,
  });

  return captured;
}

describe("DebounceConfig wire format (client.registerFunction)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serializes periodMs to snake_case period_ms", async () => {
    const body = await captureRegisterBody({ debounce: { periodMs: 2000 } });
    expect(body.debounce).toBeDefined();
    expect(body.debounce!.period_ms).toBe(2000);
  });

  it("defaults missing key to empty string for global lane", async () => {
    const body = await captureRegisterBody({ debounce: { periodMs: 2000 } });
    expect(body.debounce!.key).toBe("");
  });

  it("preserves key when provided", async () => {
    const body = await captureRegisterBody({
      debounce: { periodMs: 2000, key: "userId" },
    });
    expect(body.debounce!.key).toBe("userId");
  });

  it("omits max_wait_ms when maxWaitMs is undefined (matches Go zero-omit)", async () => {
    const body = await captureRegisterBody({ debounce: { periodMs: 2000 } });
    expect(body.debounce!.max_wait_ms).toBeUndefined();
    expect(Object.keys(body.debounce!)).not.toContain("max_wait_ms");
  });

  it("serializes maxWaitMs to snake_case max_wait_ms", async () => {
    const body = await captureRegisterBody({
      debounce: { periodMs: 2000, key: "userId", maxWaitMs: 5000 },
    });
    expect(body.debounce!.max_wait_ms).toBe(5000);
  });

  it("includes max_wait_ms when explicitly zero (Go treats 0 as 'no cap', not omitted)", async () => {
    const body = await captureRegisterBody({
      debounce: { periodMs: 2000, maxWaitMs: 0 },
    });
    // null check is the SDK's gate (`!= null` excludes only undefined/null).
    // 0 is a valid explicit "no cap" signal that Go ParseConfig accepts.
    expect(body.debounce!.max_wait_ms).toBe(0);
  });

  it("does not emit a debounce field when not configured", async () => {
    let captured: WireBody = {};
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as WireBody;
      return { ok: true, json: () => Promise.resolve({ created: true }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createClient({ serverUrl: "http://localhost:9123" });
    await client.registerFunction({
      id: "fn-no-debounce",
      triggers: [{ event: "x" }],
      endpointUrl: "http://localhost:3000/api/ironflow",
      preferredMode: "push",
    });

    expect(captured.debounce).toBeUndefined();
  });
});
