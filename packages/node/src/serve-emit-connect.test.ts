import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { IronflowService } from "../../core/src/gen/ironflow/v1/ironflow_pb.js";
import { serve } from "./serve.js";
import { createWebhook } from "./webhook.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("forwards authenticated webhook emits and deduplication keys through the generated handler", async () => {
  vi.stubEnv("IRONFLOW_API_KEY", "key");
  const router = createConnectRouter();
  let received: unknown;
  let calls = 0;
  router.service(IronflowService, {
    emit(req, ctx) {
      expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
      expect(req.event).toBe("order.placed");
      expect(req.idempotencyKey).toBe("provider-id");
      received =
        req.dataValue?.kind.case === "boolValue"
          ? req.dataValue.kind.value
          : req.data;
      calls++;
      return { eventId: "event", runIds: ["run"] };
    },
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const handler = router.handlers.find(
        (h) => h.requestPath === new URL(req.url).pathname,
      );
      return handler
        ? createFetchHandler(handler)(req)
        : new Response("missing", { status: 404 });
    },
  );
  const handler = serve({
    functions: [],
    serverUrl: "http://localhost:9123",
    skipVerification: true,
    logger: false,
    webhooks: [
      createWebhook({
        id: "test",
        verify: () => true,
        transform: () => ({
          name: "order.placed",
          data: false,
          idempotencyKey: "provider-id",
        }),
      }),
    ],
  });
  const response = await handler(
    new Request("http://localhost/webhooks/test", {
      method: "POST",
      body: "{}",
    }),
  );
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(200);
  expect(calls).toBe(1);
  expect(received).toBe(false);
});
