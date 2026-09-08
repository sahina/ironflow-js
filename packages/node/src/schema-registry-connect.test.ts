import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { EventSchemaService } from "../../core/src/gen/ironflow/v1/event_schema_pb.js";
import { createClient } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("registers, reads and deletes a schema through generated handlers", async () => {
 const router = createConnectRouter();
 let schema: { eventName: string; version: number; schemaJson: string } | undefined;
 const createdAt = timestampFromDate(new Date("2026-09-06T12:00:00Z"));
 router.service(EventSchemaService, {
  registerSchema(req, ctx) {
   expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
   schema = { eventName: req.eventName, version: req.version, schemaJson: req.schemaJson };
   return { status: "created" };
  },
  getSchema(req) {
   if (!schema || req.eventName !== schema.eventName || (req.version !== 0 && req.version !== schema.version)) throw new ConnectError("schema not found", Code.NotFound);
   return { ...schema, createdAt };
  },
  listSchemas() { return { schemas: schema ? [{ ...schema, createdAt }] : [] }; },
  deleteSchema(req) {
   if (!schema || req.eventName !== schema.eventName || req.version !== schema.version) throw new ConnectError("schema not found", Code.NotFound);
   schema = undefined;
   return {};
  },
 });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
 const client = createClient({ serverUrl: "http://localhost:9123", apiKey: "key" });
 const input = { name: "order/placed", version: 2, schema: { type: "object" } };
 expect(await client.schemas.register(input)).toMatchObject({ status: "created", event_name: input.name, version: 2, schema: input.schema });
 const latest = await client.schemas.get(input.name);
 expect(latest).toMatchObject({ event_name: input.name, version: 2, schema: input.schema, schema_json: '{"type":"object"}', created_at: "2026-09-06T12:00:00Z" });
 expect(await client.schemas.getVersion(input.name, 2)).toEqual(latest);
 for (const version of [0, NaN, Infinity, 1.5, 4294967296]) {
  await expect(client.schemas.getVersion(input.name, version)).rejects.toMatchObject({ code: "invalid_argument", retryable: false });
 }
 expect(await client.schemas.list()).toEqual([latest]);
 await expect(client.schemas.delete(input.name, 2)).resolves.toBeUndefined();
 expect(await client.schemas.list()).toEqual([]);
 await expect(client.schemas.get(input.name)).rejects.toMatchObject({ code: "not_found", retryable: false });
});
