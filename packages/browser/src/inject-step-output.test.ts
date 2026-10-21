import { afterEach, expect, it, vi } from "vitest";
import { IronflowClient } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

it("sends new_output as base64 bytes and reads the camelCase, base64 reply", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ stepId: "step-1", previousOutput: b64({ who: "José" }) }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const client = new IronflowClient();
  client.configure({ serverUrl: "http://localhost:9123", auth: { apiKey: "key" }, logger: false });

  const result = await client.injectStepOutput("run-1", "step-1", { corrected: "é" }, "fix");

  expect(result).toEqual({ stepId: "step-1", previousOutput: { who: "José" } });
  const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toEqual({ run_id: "run-1", step_id: "step-1", new_output: b64({ corrected: "é" }), reason: "fix" });
});

it("sends null as a JSON document and reads an omitted previousOutput as null", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stepId: "step-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new IronflowClient();
  client.configure({ serverUrl: "http://localhost:9123", logger: false });

  expect(await client.injectStepOutput("run-1", "step-1", null)).toEqual({ stepId: "step-1", previousOutput: null });
  // "null" in base64: JSON text like it happens to be valid base64 too, so only the bytes tell them apart.
  const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.new_output).toBe("bnVsbA==");
});
