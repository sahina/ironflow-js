import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { ProjectionService } from "../../core/src/gen/ironflow/v1/projection_pb.js";
import { createClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

it("batch wait keeps timeout, exact input sequences, item errors, and numeric results", async () => {
 const router = createConnectRouter();
 router.service(ProjectionService, {
  waitProjectionCatchupBatch(req) {
   expect(req.items[0]?.minSeq).toBe(9007199254740993n);
   expect(req.timeout).toMatchObject({ seconds: 1n, nanos: 250000000 });
   return { results: [{ result: { caughtUp: true, currentSeq: 42n, targetSeq: 40n, mode: "managed" } }, { error: "projection not found" }] };
  },
 });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
 const client = createClient({ serverUrl: "http://localhost:9123" });
 const results = await client.projections.waitForCatchupBatch([{ name: "orders", minSeq: 9007199254740993n }, { name: "missing", minSeq: 1 }], { timeoutMs: 1250 });
 expect(results).toEqual([{ result: { caughtUp: true, timedOut: false, currentSeq: 42, targetSeq: 40, behindByEvents: 0, rebuilding: false, mode: "managed" } }, { error: "projection not found" }]);
});

it("event wait keeps duration, event identity, and default result fields", async () => {
 const router = createConnectRouter();
 router.service(ProjectionService, {
  waitForEvent(req) {
   expect(req.eventId).toBe("evt-42");
   expect(req.projection).toBe("orders");
   expect(req.partition).toBe("customer-1");
   expect(req.timeout).toMatchObject({ seconds: 1n, nanos: 250000000 });
   return { caughtUp: true, currentSeq: 42n, targetSeq: 40n, mode: "managed" };
  },
 });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, { ...init, signal: undefined });
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
 const client = createClient({ serverUrl: "http://localhost:9123" });
 const result = await client.projections.waitForEvent("evt-42", "orders", { timeoutMs: 1250, partition: "customer-1" });
 expect(result).toEqual({ caughtUp: true, timedOut: false, currentSeq: 42, targetSeq: 40, behindByEvents: 0, rebuilding: false, mode: "managed" });
});

it("both wait methods preserve a rejected RPC as a permanent SDK error", async () => {
 const router = createConnectRouter();
 const reject = () => { throw new ConnectError("invalid projection", Code.InvalidArgument); };
 router.service(ProjectionService, { waitProjectionCatchupBatch: reject, waitForEvent: reject });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
 const client = createClient({ serverUrl: "http://localhost:9123" });
 await expect(client.projections.waitForCatchupBatch([{ name: "orders", minSeq: 1 }])).rejects.toMatchObject({ code: "invalid_argument", retryable: false });
 await expect(client.projections.waitForEvent("evt-42", "orders")).rejects.toMatchObject({ code: "invalid_argument", retryable: false });
});
