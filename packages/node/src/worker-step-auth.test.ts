import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FunctionContext } from "@ironflow/core";
import { createWorker } from "./worker.js";

// Step callbacks made from a pull worker (step.publish) must carry the worker's
// API key. The worker resolves it for polling; before #1672 it never reached the
// execution context, so every publish from a pull-mode function 401'd.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Drive the real REST worker through one job whose handler publishes once. */
async function runPublishJob(apiKey?: string): Promise<Record<string, string>> {
  let served = false;
  let publishHeaders: Record<string, string> = {};
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/Publish")) {
        publishHeaders = init?.headers ?? {};
        return { ok: true, status: 200, json: async () => ({ sequence: "1" }) };
      }
      if (method === "GET" && url.includes("/jobs")) {
        if (served) return { status: 204, ok: false };
        served = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [
              {
                job_id: "run-1",
                run_id: "run-1",
                function_id: "fn",
                attempt: 1,
                event: { id: "e1", name: "e", data: {}, timestamp: new Date().toISOString() },
                completed_steps: [],
                execution_seq: 5,
                lease_token: "tok-1",
              },
            ],
          }),
        };
      }
      if (method === "PUT" && url.endsWith("/ack")) {
        return { ok: true, status: 200 };
      }
      if (method === "PUT" && url.includes("/jobs/run-1")) {
        resolveDone();
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    }
  );

  const fn = {
    config: { id: "fn" },
    handler: async (ctx: FunctionContext) => {
      await ctx.step.publish("orders", { id: "1" });
      return { ok: true };
    },
  } as unknown as Parameters<typeof createWorker>[0]["functions"][number];

  const worker = createWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    logger: noopLogger,
    ...(apiKey ? { apiKey } : {}),
  });

  void worker.start();
  // 2s, not 5s: vitest's default test timeout is 5000ms, so a 5s guard races it
  // and the useful "timeout waiting for job" message loses on a loaded box.
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise((_, rej) => {
        guard = setTimeout(() => rej(new Error("timeout waiting for job")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  await worker.stop();
  return publishHeaders;
}

describe("pull worker step callback auth (#1672)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("authenticates step.publish with IRONFLOW_API_KEY", async () => {
    vi.stubEnv("IRONFLOW_API_KEY", "env-key");
    const headers = await runPublishJob();
    expect(headers.Authorization).toBe("Bearer env-key");
  });

  it("authenticates step.publish with an explicit apiKey", async () => {
    vi.stubEnv("IRONFLOW_API_KEY", "env-key");
    const headers = await runPublishJob("explicit-key");
    expect(headers.Authorization).toBe("Bearer explicit-key");
  });
});
