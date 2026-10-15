import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { createEventDefinitionRegistry, defineEvent } from "@ironflow/core";
import { serve } from "./serve.js";
import { createFunction } from "./function.js";

function body(name = "test.event", version?: number) {
  return {
    run_id: "run_1",
    function_id: "fn",
    attempt: 1,
    event: { id: "e1", name, version, data: { id: "1" }, timestamp: "2024-01-01T00:00:00Z" },
    steps: [],
  };
}

// A step output JSON cannot encode (a BigInt) fails the run non-retryably and
// keeps the earlier steps, instead of a hung or 500 response (#2874).
describe("serve: unencodable output", () => {
  let compensated = false;
  const fn = createFunction({ id: "fn", triggers: [{ event: "test.event" }] }, async ({ step }) => {
    await step.run("charge", async () => 1);
    step.compensate("charge", async () => {
      compensated = true;
    });
    await step.run("calc", async () => ({ id: 1n }));
    return { ok: true };
  });

  function expectSerializationFailure(status: number, text: string) {
    expect(status).toBe(200);
    const resp = JSON.parse(text);
    expect(resp.status).toBe("failed");
    expect(resp.error.code).toBe("SERIALIZATION_ERROR");
    expect(resp.error.retryable).toBe(false);
    // The unencodable step is dropped; the compensation that ran is kept.
    expect(resp.steps.map((s: { name: string }) => s.name)).toEqual(["charge", "compensate:charge"]);
  }

  it("Fetch-style handler", async () => {
    compensated = false;
    const handler = serve({ functions: [fn], skipVerification: true, logger: false });
    const res = (await handler(
      new Request("http://localhost/api/ironflow", { method: "POST", body: JSON.stringify(body()) }),
    )) as Response;
    expectSerializationFailure(res.status, await res.text());
    expect(compensated).toBe(true);
  });

  it("node:http handler answers instead of hanging", async () => {
    const handler = serve({ functions: [fn], skipVerification: true, logger: false }) as any;
    const rejections: unknown[] = [];
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((e: unknown) => {
        rejections.push(e);
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ironflow`, {
        method: "POST",
        body: JSON.stringify(body()),
        signal: AbortSignal.timeout(3000),
      });
      expectSerializationFailure(res.status, await res.text());
      expect(rejections).toEqual([]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

// A broken upcaster fails every attempt the same way: a non-retryable failed
// result, not a retryable 500 (#2874).
describe("serve: upcast failure", () => {
  it("is a non-retryable failure", async () => {
    const reg = createEventDefinitionRegistry();
    reg.register(defineEvent({ name: "test.event", version: 1 }));
    reg.register(
      defineEvent({
        name: "test.event",
        version: 2,
        upcast: () => {
          throw new Error("upcast boom");
        },
      }),
    );
    const fn = createFunction({ id: "fn", triggers: [{ event: "test.event" }] }, async () => ({ ok: true }));
    const handler = serve({ functions: [fn], skipVerification: true, logger: false, eventDefinitions: reg } as any);
    const res = (await handler(
      new Request("http://localhost/api/ironflow", { method: "POST", body: JSON.stringify(body("test.event", 1)) }),
    )) as Response;
    expect(res.status).toBe(200);
    const resp = JSON.parse(await res.text());
    expect(resp.status).toBe("failed");
    expect(resp.error.retryable).toBe(false);
    expect(resp.error.message).toContain("upcast boom");
  });
});
