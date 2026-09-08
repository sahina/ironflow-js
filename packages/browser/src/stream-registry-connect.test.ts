import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { EntityStreamService } from "../../core/src/gen/ironflow/v1/entity_stream_pb.js";
import { IronflowClient } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("reads streams and arbitrary history data through generated handlers", async () => {
  const router = createConnectRouter();
  let denied = false;
  router.service(EntityStreamService, {
    listStreams(_req, ctx) {
      expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
      if (denied) throw new ConnectError("denied", Code.Unauthenticated);
      return {
        streams: [
          {
            entityId: "order/1",
            entityType: "order",
            version: 2n,
            eventCount: 2n,
            updatedAt: timestampFromDate(new Date("2026-09-06T12:00:00Z")),
          },
        ],
      };
    },
    getEntityHistory(req) {
      expect(req.entityId).toBe("order/1");
      return {
        entries: [
          {
            eventName: "order.created",
            entityVersion: 2n,
            eventDataValue: { kind: { case: "stringValue", value: "created" } },
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
  expect(await client.streams.listStreams()).toEqual([
    {
      entityId: "order/1",
      entityType: "order",
      version: 2,
      eventCount: 2,
      lastEventAt: "2026-09-06T12:00:00Z",
    },
  ]);
  expect(await client.streams.getEntityHistory("order/1")).toEqual([
    { eventName: "order.created", data: "created", version: 2, timestamp: "" },
  ]);
  denied = true;
  await expect(client.streams.listStreams()).rejects.toMatchObject({
    retryable: false,
  });
});
