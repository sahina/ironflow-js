import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The streaming worker's step-auth wiring had no coverage: worker-streaming.test.ts
// drives a hand-rolled mock class, so deleting the apiKey argument from the real
// ExecutionContext construction left the whole suite green (#1672 review).
// Reaching executeJob for real needs a ConnectRPC stream, so this spies on the
// constructor instead — enough to fail if the argument goes missing.

const ctorArgs: unknown[][] = [];

vi.mock("./internal/context.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./internal/context.js")>();
  return {
    ...mod,
    ExecutionContext: class extends mod.ExecutionContext {
      constructor(...args: ConstructorParameters<typeof mod.ExecutionContext>) {
        ctorArgs.push(args);
        super(...args);
      }
    },
  };
});

const { createStreamingWorker } = await import("./worker-streaming.js");

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Drive the real StreamingWorker's executeJob and return the 6th ctor arg. */
async function apiKeyReachingContext(apiKey?: string): Promise<unknown> {
  ctorArgs.length = 0;

  const fn = {
    config: { id: "fn" },
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof createStreamingWorker>[0]["functions"][number];

  const worker = createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    logger: noopLogger,
    ...(apiKey ? { apiKey } : {}),
  });

  const job = {
    jobId: "job-1",
    runId: "run-1",
    functionId: "fn",
    attempt: 1,
    event: { id: "e1", name: "e", data: {}, timestamp: undefined },
    completedSteps: [],
  };

  // executeJob is private at the type level only. Terminal reporting goes out
  // over a stream this test does not open, so failures there are irrelevant.
  await (worker as unknown as {
    executeJob(job: unknown, signal: AbortSignal): Promise<void>;
  })
    .executeJob(job, new AbortController().signal)
    .catch(() => {});

  expect(ctorArgs.length).toBeGreaterThan(0);
  return ctorArgs[0]![5];
}

describe("streaming worker step callback auth (#1672)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("passes IRONFLOW_API_KEY into the execution context", async () => {
    vi.stubEnv("IRONFLOW_API_KEY", "env-key");
    expect(await apiKeyReachingContext()).toBe("env-key");
  });

  it("prefers an explicit apiKey over the env var", async () => {
    vi.stubEnv("IRONFLOW_API_KEY", "env-key");
    expect(await apiKeyReachingContext("explicit-key")).toBe("explicit-key");
  });
});
