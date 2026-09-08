import { afterEach, expect, it, vi } from "vitest";
import { createConnectRouter, ConnectError, Code } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { IronflowService } from "../../core/src/gen/ironflow/v1/ironflow_pb.js";
import { createClient } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("retains step payloads, duration presence and typed errors through the generated handler", async () => {
  const router = createConnectRouter();
  router.service(IronflowService, {
    getRunSteps(req, ctx) {
      expect(ctx.requestHeader.get("Authorization")).toBe("Bearer key");
      if (req.runId === "missing")
        throw new ConnectError("missing", Code.NotFound);
      return {
        steps: [
          {
            id: "row",
            runId: req.runId,
            stepId: "undo",
            stepType: 4,
            status: 3,
            outputValue: { kind: { case: "boolValue", value: false } },
            durationMsFull: 2147483648n,
            compensationFor: "charge",
            waitEventName: "wake",
            createdAt: timestampFromDate(new Date("2026-09-06T12:00:00Z")),
          },
          { id: "zero", durationMsFull: 0n },
          { id: "absent" },
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
        : new Response("missing", { status: 404 });
    },
  );
  const client = createClient({
    serverUrl: "http://localhost:9123",
    apiKey: "key",
  });
  const result = await client.getRunSteps("run");
  expect(result).toMatchObject({
    count: 3,
    steps: [
      {
        id: "row",
        stepType: "compensate",
        status: "completed",
        output: false,
        durationMs: 2147483648,
        compensationFor: "charge",
        waitEventName: "wake",
        createdAt: "2026-09-06T12:00:00Z",
      },
      { id: "zero", durationMs: 0 },
      { id: "absent" },
    ],
  });
  expect(result.steps[2]?.durationMs).toBeUndefined();
  await expect(client.getRunSteps("missing")).rejects.toMatchObject({
    retryable: false,
  });
});
