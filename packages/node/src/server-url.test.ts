import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "./client.js";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";
import { createFunction } from "./function.js";
import { createDefaultMemoryBackend } from "./agent/agent.js";
import { exposeMcp } from "./agent/mcp.js";
import { clearLocalForTests } from "./agent/internal-registry.js";
import { serve } from "./serve.js";
import { createWebhook } from "./webhook.js";
import { assertDefined } from "./internal/assert-defined.js";

describe("server URL environment resolution", () => {
  let server: Server;
  let url: string;
  let requests: string[];

  beforeEach(async () => {
    requests = [];
    clearLocalForTests();
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "ok", jobs: [], entityVersion: "1", eventId: "evt_1", sequence: "1",
        hmacSecret: "ab".repeat(32), registeredToolNames: ["url-test.noop"],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    url = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("IRONFLOW_NO_DISCOVERY", "1");
    vi.stubEnv("IRONFLOW_API_KEY", "ifkey_test");
    vi.stubEnv("IRONFLOW_SERVER_URL", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearLocalForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(["env", "explicit"])(
    "uses the same selected server across Node entrypoints with %s",
    async (source) => {
      // An explicit serverUrl must beat a wrong IRONFLOW_SERVER_URL.
      vi.stubEnv("IRONFLOW_SERVER_URL", source === "env" ? url : "http://127.0.0.1:1");
      const config = source === "explicit" ? { serverUrl: url } : {};
      expect(await createClient(config).health()).toBe("ok");
      if (source === "env") {
        const backend = assertDefined(createDefaultMemoryBackend());
        expect(await backend.appendEvent("agent_1", { name: "note", data: {}, entityType: "agent", idempotencyKey: "url-test-note" }))
          .toEqual({ entityVersion: 1, eventId: "evt_1" });
      }
      const handle = await exposeMcp({
        ...config, name: "url-test", version: "1", callbackUrl: "http://localhost/tools",
        tools: [{ name: "noop", description: "", input: z.object({}), handler: async () => ({}) }],
      });
      expect(handle.status).toBe("active");
      const webhook = createWebhook({
        id: "url-test", verify: async () => {},
        transform: async () => ({ name: "url.test", data: {} }),
      });
      const handler = serve({ ...config, functions: [], webhooks: [webhook], logger: false });
      const response = await handler(new Request("http://localhost/webhooks/url-test", {
        method: "POST", body: "{}",
      }));
      expect(response?.status).toBe(200);
      expect(requests).toContain("/ironflow.v1.IronflowService/Health");
      expect(requests).toContain("/ironflow.v1.AgentToolsService/RegisterTool");
      expect(requests).toContain("/ironflow.v1.IronflowService/Emit");

      const fn = createFunction({ id: "url-test", triggers: [{ event: "url.test" }] },
        async ({ step }) => step.publish("url-test", {}));
      const pushHandler = serve({ ...config, functions: [fn], skipVerification: true, logger: false });
      const pushResponse = await pushHandler(new Request("http://localhost/api/ironflow", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: "run_1", function_id: "url-test", attempt: 1, steps: [],
          event: { id: "evt_1", name: "url.test", data: {}, timestamp: "2024-01-01T00:00:00Z" },
        }),
      }));
      if (!pushResponse) throw new Error("Push handler returned no response");
      expect(await pushResponse.json()).toMatchObject({
        status: "completed", result: { eventId: "evt_1", sequence: 1 },
      });
      expect(requests).toContain("/ironflow.v1.PubSubService/Publish");
    },
  );

  it("registers a pull worker from IRONFLOW_SERVER_URL", async () => {
    vi.stubEnv("IRONFLOW_SERVER_URL", url);
    const worker = createWorker({ functions: [], logger: false, reconnectDelay: 10 });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(requests.some((path) => path.endsWith("/register"))).toBe(true));
    } finally {
      await worker.stop();
      await running;
    }
  });

  it("registers a streaming worker from IRONFLOW_SERVER_URL", async () => {
    vi.stubEnv("IRONFLOW_SERVER_URL", url);
    const worker = createStreamingWorker({
      functions: [createFunction({ id: "url-test", triggers: [{ event: "url.test" }] }, async () => ({}))],
      logger: false, reconnectDelay: 10,
    });
    server.once("request", () => worker.stop());
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(requests).toContain("/ironflow.v1.IronflowService/RegisterFunction"));
    } finally {
      await worker.stop();
      await running;
    }
  });
});
