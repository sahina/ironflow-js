import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["polling", createWorker],
  ["streaming", createStreamingWorker],
] as const)("%s registration errors (#2686)", (_name, create) => {
  it.each([[400, undefined], [422, undefined], [503, false], [408, false]] as const)("stops on a terminal %s and reports the rejected function", async (status, retryable) => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)).id);
      // A second attempt fails auth so the broken reconnect loop cannot hang the test.
      return new Response(JSON.stringify({ message: "invalid function config", retryable }), {
        status: requests.length === 1 ? status : 401,
      });
    });
    const worker = create({
      functions: [
        { config: { id: "bad", triggers: [] }, handler: async () => null },
        { config: { id: "later", triggers: [] }, handler: async () => null },
      ],
      reconnectDelay: 1,
      logger,
    });
    try {
      await expect(worker.start()).rejects.toThrow(/bad.*invalid function config/);
      expect(requests).toEqual(["bad"]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0]?.[0]).not.toMatch(/authentication/);
    } finally {
      worker.stop();
    }
  });

  it.each([408, 429, 503, 400])("recovers from retryable %s and registers later functions", async (status) => {
    const requests: string[] = [];
    const worker = create({
      functions: [
        { config: { id: "first", triggers: [] }, handler: async () => null },
        { config: { id: "later", triggers: [] }, handler: async () => null },
      ],
      reconnectDelay: 1,
      logger: false,
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const id = JSON.parse(String(init.body)).id;
      requests.push(id);
      if (requests.length === 1) {
        return new Response(JSON.stringify(status === 400 ? { retryable: true } : {}), { status });
      }
      if (id === "later") worker.stop();
      return new Response("{}", { status: 200 });
    });
    try {
      await worker.start();
      expect(requests).toEqual(["first", "first", "later"]);
    } finally {
      worker.stop();
    }
  });
});
