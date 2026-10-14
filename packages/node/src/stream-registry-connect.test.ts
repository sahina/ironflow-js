import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { EntityStreamService } from "../../core/src/gen/ironflow/v1/entity_stream_pb.js";
import { createClient } from "./client.js";
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
      if (denied) throw new ConnectError("denied", Code.Unauthenticated);
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
      const request = new Request(input, init);
      const handler = router.handlers.find(
        (h) => h.requestPath === new URL(request.url).pathname,
      );
      return handler
        ? createFetchHandler(handler)(request)
        : new Response("not found", { status: 404 });
    },
  );
  const onError = vi.fn();
  const client = createClient({
    serverUrl: "http://localhost:9123",
    apiKey: "key",
    onError,
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
  expect(onError).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ method: "streams.listStreams", statusCode: 401 }),
  );
  await expect(
    client.streams.getEntityHistory("order/1"),
  ).rejects.toMatchObject({ retryable: false });
  expect(onError).toHaveBeenLastCalledWith(
    expect.any(Error),
    expect.objectContaining({
      method: "streams.getEntityHistory",
      statusCode: 401,
    }),
  );
});

it("follows next_cursor and sends the time window on every page", async () => {
  const router = createConnectRouter();
  const seen: Array<{ fromVersion: bigint; from?: string; to?: string }> = [];
  router.service(EntityStreamService, {
    getEntityHistory(req) {
      seen.push({
        fromVersion: req.fromVersion,
        from: req.fromTimestamp && timestampDate(req.fromTimestamp).toISOString(),
        to: req.toTimestamp && timestampDate(req.toTimestamp).toISOString(),
      });
      const page = (v: bigint) => ({ eventName: "order.updated", entityVersion: v });
      return req.fromVersion === 2n
        ? { entries: [page(2n), page(3n)], nextCursor: 4n }
        : { entries: [page(4n)] };
    },
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const handler = router.handlers.find(
        (h) => h.requestPath === new URL(request.url).pathname,
      );
      return handler
        ? createFetchHandler(handler)(request)
        : new Response("not found", { status: 404 });
    },
  );
  const client = createClient({ serverUrl: "http://localhost:9123", apiKey: "key" });
  const history = await client.streams.getEntityHistory("order/1", {
    fromVersion: 2,
    from: new Date("2026-09-01T00:00:00Z"),
    to: "2026-09-06T12:00:00Z",
  });
  expect(history.map((e) => e.version)).toEqual([2, 3, 4]);
  const window = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-06T12:00:00.000Z" };
  expect(seen).toEqual([
    { fromVersion: 2n, ...window },
    { fromVersion: 4n, ...window },
  ]);
});
