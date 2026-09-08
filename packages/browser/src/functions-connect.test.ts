import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { IronflowService } from "../../core/src/gen/ironflow/v1/ironflow_pb.js";
import { IronflowClient } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("retains function list fields and typed errors through a generated handler", async () => {
  const router = createConnectRouter();
  let denied = false;
  router.service(IronflowService, {
    listFunctions(_req, ctx) {
      expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
      if (denied) throw new ConnectError("denied", Code.Unauthenticated);
      return {
        functions: [
          {
            id: "fn",
            name: "Name",
            status: 1,
            preferredMode: 2,
            version: 3,
            retry: { maxAttempts: 4, initialDelayMs: 100, backoffFactor: 2 },
            concurrency: { limit: 2 },
            debounce: { periodMs: 1000, maxWaitMs: 5000n, key: "id" },
            cancelOn: [{ event: "order.cancelled", match: "id" }],
            metadata: { camelKey: true },
            createdAt: timestampFromDate(new Date("2026-09-06T12:00:00Z")),
          },
        ],
      };
    },
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, { ...init, signal: undefined });
      const handler = router.handlers.find(
        (h) => h.requestPath === new URL(request.url).pathname,
      );
      return handler
        ? createFetchHandler(handler)(request)
        : new Response("not found", { status: 404 });
    },
  );
  const client = new IronflowClient();
  client.configure({
    serverUrl: "http://localhost:9123",
    auth: { apiKey: "key" },
    logger: false,
  });
  expect(await client.listFunctions()).toMatchObject([
    {
      id: "fn",
      slug: "fn",
      status: "active",
      execution_mode: "pull",
      version: 3,
      retry_attempts: 4,
      retry_delay_ms: 100,
      retry_backoff: 2,
      concurrency: { limit: 2 },
      debounce: { period_ms: 1000, max_wait_ms: 5000, key: "id" },
      cancel_on: [{ event: "order.cancelled", match: "id" }],
      metadata: { camelKey: true },
      created_at: "2026-09-06T12:00:00Z",
    },
  ]);
  denied = true;
  await expect(client.listFunctions()).rejects.toMatchObject({
    retryable: false,
  });
});
