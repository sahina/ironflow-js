import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { EventSchemaService } from "../../core/src/gen/ironflow/v1/event_schema_pb.js";
import { IronflowError } from "@ironflow/core";
import { IronflowClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

function serveUpcast(failure?: Code) {
 const router = createConnectRouter();
 router.service(EventSchemaService, {
  testUpcast(req) {
   if (failure) throw new ConnectError("rejected", failure);
   if (!req.eventName) throw new ConnectError("event_name is required", Code.InvalidArgument);
   return { data: req.data, dataValue: req.dataValue, stepsApplied: [{ fromVersion: 1, toVersion: 2, description: "upcast to v2" }] };
  },
 });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, { ...init, signal: undefined });
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
}

describe("schema upcast over Connect", () => {
 it.each([{ orderId: "order-1" }, ["order-1", true, null], "value", null].map(data => ({ data })))("preserves payload %j", async ({ data }) => {
  serveUpcast();
  const client = new IronflowClient(); client.configure({ serverUrl: "http://localhost:9123", logger: false });
  const result = await client.schemas.testUpcast({ eventName: "order.placed", fromVersion: 1, toVersion: 2, data });
  expect(result).toEqual({ success: true, data });
 });
 it("returns a permanent SDK error for invalid input", async () => {
  serveUpcast();
  const client = new IronflowClient(); client.configure({ serverUrl: "http://localhost:9123", logger: false });
  const result = client.schemas.testUpcast({ eventName: "", fromVersion: 1, toVersion: 2, data: {} });
  await expect(result).rejects.toBeInstanceOf(IronflowError);
  await expect(result).rejects.toMatchObject({ code: "invalid_argument", retryable: false });
 });
});

it("preserves the browser rate-limit retry policy", async () => {
 serveUpcast(Code.ResourceExhausted);
 const client = new IronflowClient(); client.configure({ serverUrl: "http://localhost:9123", logger: false });
 await expect(client.schemas.testUpcast({ eventName: "x", fromVersion: 1, toVersion: 2, data: {} })).rejects.toMatchObject({ status: 429, retryable: true });
});
