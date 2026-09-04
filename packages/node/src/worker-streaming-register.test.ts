import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamingWorker } from "./worker-streaming.js";

// #2027: the streaming worker connected, heartbeated and executed nothing because
// it never registered the function DEFINITIONS — only the worker frame, which
// carries names and no triggers. The event router then matched nothing.

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeWorker(
  apiKey?: string,
  projections?: Parameters<typeof createStreamingWorker>[0]["projections"]
) {
  const fn = {
    config: { id: "fn", triggers: [{ event: "demo.go" }] },
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof createStreamingWorker>[0]["functions"][number];

  return createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    logger: noopLogger,
    ...(apiKey ? { apiKey } : {}),
    ...(projections ? { projections } : {}),
  });
}

/** Drive the real connect(); it fails once it reaches the stream, which is fine. */
async function connectCalls(
  apiKey?: string,
  projections?: Parameters<typeof createStreamingWorker>[0]["projections"]
): Promise<[string, RequestInit][]> {
  const calls: [string, RequestInit][] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const worker = makeWorker(apiKey, projections);
  await (worker as unknown as { connect(): Promise<void> })
    .connect()
    .catch(() => {});
  worker.stop();
  return calls;
}

describe("streaming worker function registration (#2027)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers function definitions before opening the stream", async () => {
    const calls = await connectCalls();
    const reg = calls.find(([url]) =>
      url.endsWith("/ironflow.v1.IronflowService/RegisterFunction")
    );
    expect(reg).toBeDefined();
    const body = JSON.parse(reg![1].body as string);
    expect(body.id).toBe("fn");
    expect(body.triggers).toEqual([{ event: "demo.go" }]);
    expect(body.preferredMode).toBe("EXECUTION_MODE_PULL");
  });

  it("sends auth and environment headers with the registration", async () => {
    vi.stubEnv("IRONFLOW_ENV", "staging");
    const calls = await connectCalls("secret-key");
    const reg = calls.find(([url]) =>
      url.endsWith("/ironflow.v1.IronflowService/RegisterFunction")
    );
    const headers = reg![1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key");
    expect(headers["X-Ironflow-Environment"]).toBe("staging");
  });

  it("stops instead of reconnecting when registration is unauthorized", async () => {
    // A bad API key does not fix itself on the reconnect cadence (#1673). The
    // registration fetch throws UnauthenticatedError, not a ConnectError, so
    // the start() guard has to catch that shape too — otherwise the worker
    // spins forever, which is the #2027 symptom all over again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    );
    const worker = makeWorker("bad-key");
    await expect(worker.start()).rejects.toThrow(/401 unauthenticated/);
  });

  it("fails the connection when registration is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    const worker = makeWorker();
    await expect(
      (worker as unknown as { connect(): Promise<void> }).connect()
    ).rejects.toThrow(/Failed to register function fn/);
    worker.stop();
  });
});

describe("streaming worker projections (#2027 follow-up)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the projection runners it was handed", async () => {
    // config.projections was accepted and silently ignored: the polling worker
    // starts runners, the streaming worker had no reference to them at all.
    const projection = {
      config: { name: "proj", events: ["demo.go"], mode: "managed" },
      reducer: () => ({}),
    } as unknown as NonNullable<
      Parameters<typeof createStreamingWorker>[0]["projections"]
    >[number];

    const calls = await connectCalls(undefined, [projection]);
    const registered = calls.some(([url]) =>
      url.includes("/ironflow.v1.ProjectionService/")
    );
    expect(registered).toBe(true);
  });
});
