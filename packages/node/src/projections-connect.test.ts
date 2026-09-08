import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { ProjectionService } from "../../core/src/gen/ironflow/v1/projection_pb.js";
import { createClient } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("preserves projection state, registry metadata, waits and errors through generated handlers", async () => {
  const router = createConnectRouter();
  router.service(ProjectionService, {
    getProjection(req, ctx) {
      expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
      if (req.name === "missing")
        throw new ConnectError("missing", Code.NotFound);
      return {
        name: req.name,
        partition: req.partition || "__global__",
        mode: "managed",
        version: 3n,
        ...(req.name === "empty"
          ? {}
          : {
              stateValue: {
                kind: { case: "boolValue" as const, value: false },
              },
            }),
        registry: {
          name: req.name,
          mode: "managed",
          versionFull: 2147483648n,
          lastEventSeq: 2147483649n,
          status: "active",
          errorMessage: "previous",
        },
      };
    },
    listProjections() {
      return {
        projections: [
          {
            name: "orders",
            status: "active",
            mode: "managed",
            lastEventSeq: 2147483649n,
            errorMessage: "previous",
          },
        ],
      };
    },
    getProjectionStatus() {
      return {
        name: "orders",
        status: "paused",
        mode: "managed",
        lastEventSeq: 2147483649n,
        errorMessage: "previous",
      };
    },
    waitProjectionCatchup(req) {
 if ((req.timeout?.seconds ?? 0n) < 0n || (req.timeout?.nanos ?? 0) < 0) throw new ConnectError("timeout must be positive",Code.InvalidArgument);
      expect(req.minSeq).toBe(9007199254740993n);
      expect(req.timeout?.seconds).toBe(1n);
      expect(req.timeout?.nanos).toBe(500000000);
      return {
        caughtUp: true,
        currentSeq: 42n,
        targetSeq: 42n,
        mode: "managed",
      };
    },
    rebuildProjection() {
      return {
        job: { projectionName: "orders", status: "running", progress: 25 },
      };
    },
    getRebuildJob() {
      return {
        job: { projectionName: "orders", status: "running", progress: 25 },
      };
    },
    pauseProjection(req) {
      expect(req.name).toBe("orders");
      return { status: "paused" };
    },
    resumeProjection(req) {
      expect(req.name).toBe("orders");
      return { status: "active" };
    },
    cancelRebuild(req) {
      expect(req.name).toBe("orders");
      return { status: "cancelled" };
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
        : new Response("missing", { status: 404 });
    },
  );
  const onError = vi.fn();
  const client = createClient({
    serverUrl: "http://localhost:9123",
    apiKey: "key",
    onError,
  });
  const get = client.projections.get;
  const list = client.projections.list;
  const status = client.projections.getStatus;
  const wait = client.projections.waitForCatchup;
  expect(await get("orders", { partition: "customer" })).toMatchObject({
    name: "orders",
    partition: "customer",
    state: false,
    version: 2147483648,
    lastEventSeq: 2147483649,
    status: "active",
    errorMessage: "previous",
  });
  expect(await get("empty")).toMatchObject({
    state: {},
    partition: "__global__",
  });
  expect(await list()).toMatchObject([{ name: "orders", status: "active" }]);
  expect(await status("orders")).toMatchObject({
    name: "orders",
    status: "paused",
    lastEventSeq:2147483649, errorMessage:"previous",
last_event_seq:2147483649, error_message:"previous",
  });
  expect(
    await wait("orders", { minSeq: 9007199254740993n, timeoutMs: 1500 }),
  ).toEqual({
    caughtUp: true,
    timedOut: false,
    currentSeq: 42,
    targetSeq: 42,
    behindByEvents: 0,
    rebuilding: false,
    mode: "managed",
  });
  await expect(wait("orders",{minSeq:1,timeoutMs:-5000})).rejects.toMatchObject({retryable:false});
  await expect(get("missing")).rejects.toMatchObject({ retryable: false });
  expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({method:"projections.get"}));
  expect(await client.projections.rebuild("orders")).toMatchObject({
    name: "orders",
    status: "running",
    progress: 25,
  });
  expect(await client.projections.getRebuildJob("orders")).toMatchObject({
    name: "orders",
    status: "running",
    progress: 25,
  });
  await client.projections.pause("orders");
  await client.projections.resume("orders");
  await client.projections.cancelRebuild("orders");
});
