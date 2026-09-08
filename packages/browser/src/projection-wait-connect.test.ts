import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { ProjectionService } from "../../core/src/gen/ironflow/v1/projection_pb.js";
import { IronflowClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());


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
 const client = new IronflowClient(); client.configure({ serverUrl: "http://localhost:9123", logger: false });
 const result = await client.waitForEvent("evt-42", "orders", { timeoutMs: 1250, partition: "customer-1" });
 expect(result).toEqual({ caughtUp: true, timedOut: false, currentSeq: 42, targetSeq: 40, behindByEvents: 0, rebuilding: false, mode: "managed" });
});

it("keeps the wait deadline plus two-second transport margin", async () => {
 vi.useFakeTimers();
 vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
 }));
 const client = new IronflowClient();
 client.configure({ serverUrl: "http://localhost:9123", logger: false });
 try {
  const result = client.waitForEvent("evt-42", "orders", { timeoutMs: 1250 }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3250);
  expect(await result).toMatchObject({ code: "TIMEOUT", retryable: true });
 } finally {
  vi.useRealTimers();
 }
});
