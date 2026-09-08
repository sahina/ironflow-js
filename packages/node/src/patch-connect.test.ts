import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { IronflowService } from "../../core/src/gen/ironflow/v1/ironflow_pb.js";
import { createClient } from "./client.js";
afterEach(() => { vi.unstubAllGlobals();  });
it("patches through the generated service with auth and default reason", async () => {
 const router = createConnectRouter();
 const patches: unknown[] = [];
 router.service(IronflowService, { patchStep(req, ctx) {
  expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
  if (req.stepId === "missing") throw new ConnectError("step not found", Code.NotFound);
  patches.push({ stepId: req.stepId, output: req.output, reason: req.reason });
  return { id: req.stepId, output: req.output };
 } });
 vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const handler = router.handlers.find(h => h.requestPath === new URL(request.url).pathname);
  return handler ? createFetchHandler(handler)(request) : new Response("not found", { status: 404 });
 });
 
 const client = createClient({ serverUrl: "http://localhost:9123", apiKey: "key" });
 await expect(client.patchStep("step", { result: "fixed" }, "manual fix")).resolves.toBeUndefined();
 await client.patchStep("step", { result: "again" });
 expect(patches).toEqual([
  { stepId: "step", output: { result: "fixed" }, reason: "manual fix" },
  { stepId: "step", output: { result: "again" }, reason: "" },
 ]);
 await expect(client.patchStep("missing", {})).rejects.toMatchObject({ code: "not_found", retryable: false });
});
