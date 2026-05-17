import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  clearLocalForTests,
  registerLocal,
} from "../internal-registry.js";
import { handleAgentToolDispatch, DISPATCH_PATH } from "../dispatch.js";

const SECRET_HEX = "abcdef".padEnd(64, "0");

function sign(ts: number, body: string, secret = SECRET_HEX): string {
  return (
    "sha256=" +
    createHmac("sha256", Buffer.from(secret, "hex")).update(`${ts}.${body}`).digest("hex")
  );
}

function makeRequest(body: string, headers: Record<string, string>) {
  return {
    text: async () => body,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

describe("handleAgentToolDispatch()", () => {
  beforeEach(() => {
    clearLocalForTests();
  });

  afterEach(() => {
    clearLocalForTests();
  });

  it("dispatches to the registered handler on a valid request", async () => {
    let received: { x: number } | undefined;
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.echo",
      hmacSecret: SECRET_HEX,
      def: {
        name: "echo",
        description: "echo",
        input: z.object({ x: z.number() }),
        handler: async (input: { x: number }) => {
          received = input;
          return { doubled: input.x * 2 };
        },
      },
    });

    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ qualified_name: "demo.echo", input: { x: 21 } });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ output: { doubled: 42 } });
    expect(received).toEqual({ x: 21 });
  });

  it("rejects missing HMAC headers with 401", async () => {
    const result = await handleAgentToolDispatch(makeRequest("{}", {}));
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects stale timestamps as TIMESTAMP_SKEW", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.t",
      hmacSecret: SECRET_HEX,
      def: {
        name: "t",
        description: "",
        input: z.object({}),
        handler: async () => ({}),
      },
    });
    const ts = Math.floor(Date.now() / 1000) - 600;
    const body = JSON.stringify({ qualified_name: "demo.t", input: {} });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("TIMESTAMP_SKEW");
  });

  it("rejects future-skew timestamps", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.t",
      hmacSecret: SECRET_HEX,
      def: {
        name: "t",
        description: "",
        input: z.object({}),
        handler: async () => ({}),
      },
    });
    const ts = Math.floor(Date.now() / 1000) + 600;
    const body = JSON.stringify({ qualified_name: "demo.t", input: {} });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("TIMESTAMP_SKEW");
  });

  it("rejects bad signatures with 401", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.t",
      hmacSecret: SECRET_HEX,
      def: {
        name: "t",
        description: "",
        input: z.object({}),
        handler: async () => ({}),
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ qualified_name: "demo.t", input: {} });
    const tampered = sign(ts, body).replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": tampered,
      })
    );
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("SIGNATURE_MISMATCH");
  });

  it("returns 401 SIGNATURE_MISMATCH for unknown qualified_name (collapsed to prevent enumeration)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ qualified_name: "ghost.tool", input: {} });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("SIGNATURE_MISMATCH");
    expect(result.body.error?.message).toBe("HMAC mismatch");
    expect(warnSpy).toHaveBeenCalledWith(
      'ironflow.agent.dispatch unknown_tool qualified_name="ghost.tool"'
    );
    warnSpy.mockRestore();
  });

  it("escapes control characters in qualified_name before logging (log injection defense)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000);
    const evil = "evil\nFAKE_LOG_LINE\rkey=injected";
    const body = JSON.stringify({ qualified_name: evil, input: {} });
    await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    const logged = warnSpy.mock.calls[0]?.[0] as string;
    expect(logged).not.toMatch(/[\n\r]/);
    expect(logged).toBe(
      'ironflow.agent.dispatch unknown_tool qualified_name="evil\\nFAKE_LOG_LINE\\rkey=injected"'
    );
    warnSpy.mockRestore();
  });

  it("produces an indistinguishable response envelope for unknown-tool vs bad-sig-known-tool", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.t",
      hmacSecret: SECRET_HEX,
      def: {
        name: "t",
        description: "",
        input: z.object({}),
        handler: async () => ({}),
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000);

    const bodyKnown = JSON.stringify({ qualified_name: "demo.t", input: {} });
    const knownResult = await handleAgentToolDispatch(
      makeRequest(bodyKnown, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, bodyKnown, "ff".padEnd(64, "0")),
      })
    );

    const bodyUnknown = JSON.stringify({ qualified_name: "ghost.tool", input: {} });
    const unknownResult = await handleAgentToolDispatch(
      makeRequest(bodyUnknown, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, bodyUnknown),
      })
    );

    expect(knownResult.status).toBe(unknownResult.status);
    expect(knownResult.body.error?.code).toBe(unknownResult.body.error?.code);
    expect(knownResult.body.error?.message).toBe(unknownResult.body.error?.message);
    warnSpy.mockRestore();
  });

  it("returns 400 when input fails Zod validation", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.s",
      hmacSecret: SECRET_HEX,
      def: {
        name: "s",
        description: "",
        input: z.object({ q: z.string().min(1) }),
        handler: async () => ({}),
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ qualified_name: "demo.s", input: { q: "" } });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("INPUT_SCHEMA_INVALID");
  });

  it("maps a handler throw to a 200 + HANDLER_ERROR envelope", async () => {
    registerLocal({
      agentName: "demo",
      qualifiedName: "demo.boom",
      hmacSecret: SECRET_HEX,
      def: {
        name: "boom",
        description: "",
        input: z.object({}),
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ qualified_name: "demo.boom", input: {} });
    const result = await handleAgentToolDispatch(
      makeRequest(body, {
        "x-ironflow-timestamp": String(ts),
        "x-ironflow-signature": sign(ts, body),
      })
    );
    expect(result.status).toBe(200);
    expect(result.body.error).toEqual({ code: "HANDLER_ERROR", message: "kaboom" });
  });

  it("exports the dispatch path so serve() can route on it", () => {
    expect(DISPATCH_PATH).toBe("/ironflow/agent-tools/dispatch");
  });
});
