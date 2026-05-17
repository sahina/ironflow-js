import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { exposeMcp } from "../mcp.js";
import { clearLocalForTests, lookupLocal } from "../internal-registry.js";

const SERVER_URL = "http://localhost:9123";
const CALLBACK_URL = "http://localhost:3000/api/ironflow/ironflow/agent-tools/dispatch";
const API_KEY = "ifkey_test_register";

describe("exposeMcp() — runtime", () => {
  beforeEach(() => {
    clearLocalForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.IRONFLOW_URL;
    delete process.env.IRONFLOW_SERVER_URL;
    delete process.env.IRONFLOW_API_KEY;
  });

  it("rejects empty tool list", async () => {
    await expect(
      exposeMcp({
        name: "empty",
        version: "1.0.0",
        tools: [],
        callbackUrl: CALLBACK_URL,
        serverUrl: SERVER_URL,
        apiKey: API_KEY,
      })
    ).rejects.toThrow(/at least one tool/);
  });

  it("rejects missing callbackUrl", async () => {
    await expect(
      exposeMcp({
        name: "demo",
        version: "1.0.0",
        callbackUrl: "",
        serverUrl: SERVER_URL,
        apiKey: API_KEY,
        tools: [
          { name: "noop", description: "", input: z.object({}), handler: async () => ({}) },
        ],
      })
    ).rejects.toThrow(/callbackUrl/);
  });

  it("rejects missing serverUrl when no env fallback", async () => {
    await expect(
      exposeMcp({
        name: "demo",
        version: "1.0.0",
        callbackUrl: CALLBACK_URL,
        apiKey: API_KEY,
        tools: [
          { name: "noop", description: "", input: z.object({}), handler: async () => ({}) },
        ],
      })
    ).rejects.toThrow(/serverUrl/);
  });

  it("rejects duplicate tool names", async () => {
    await expect(
      exposeMcp({
        name: "demo",
        version: "1.0.0",
        callbackUrl: CALLBACK_URL,
        serverUrl: SERVER_URL,
        apiKey: API_KEY,
        tools: [
          { name: "x", description: "", input: z.object({}), handler: async () => ({}) },
          { name: "x", description: "", input: z.object({}), handler: async () => ({}) },
        ],
      })
    ).rejects.toThrow(/duplicate tool/);
  });

  it("posts RegisterTool with JSON Schema, populates the local registry, returns active handle", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(typeof input === "string" || input instanceof URL).toBe(true);
      const url = String(input);
      expect(url).toBe(`${SERVER_URL}/ironflow.v1.AgentToolsService/RegisterTool`);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string);
      expect(body.agentName).toBe("docproc");
      expect(body.callbackUrl).toBe(CALLBACK_URL);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe("search");
      expect(body.tools[0].requiredScopes).toEqual(["search"]);
      const schema = JSON.parse(body.tools[0].inputSchemaJson);
      expect(schema.type).toBe("object");
      expect(schema.properties.q.type).toBe("string");

      return new Response(
        JSON.stringify({
          hmacSecret: "deadbeef".repeat(8),
          registeredToolNames: ["docproc.search"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const handle = await exposeMcp({
      name: "docproc",
      version: "0.1.0",
      callbackUrl: CALLBACK_URL,
      serverUrl: SERVER_URL,
      apiKey: API_KEY,
      tools: [
        {
          name: "search",
          description: "Search the corpus",
          input: z.object({ q: z.string() }),
          scopes: ["search"],
          handler: async ({ q }) => ({ hits: q.length }),
        },
      ],
    });

    expect(handle.name).toBe("docproc");
    expect(handle.toolCount).toBe(1);
    expect(handle.status).toBe("active");
    expect(handle.toolNames).toEqual(["docproc.search"]);

    const entry = lookupLocal("docproc.search");
    expect(entry).toBeDefined();
    expect(entry?.hmacSecret).toBe("deadbeef".repeat(8));
    expect(entry?.agentName).toBe("docproc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to IRONFLOW_URL + IRONFLOW_API_KEY env vars", async () => {
    process.env.IRONFLOW_URL = SERVER_URL;
    process.env.IRONFLOW_API_KEY = API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              hmacSecret: "ab".repeat(32),
              registeredToolNames: ["x.y"],
            }),
            { status: 200 }
          )
      )
    );
    const handle = await exposeMcp({
      name: "x",
      version: "0.1.0",
      callbackUrl: CALLBACK_URL,
      tools: [
        { name: "y", description: "", input: z.object({}), handler: async () => ({}) },
      ],
    });
    expect(handle.status).toBe("active");
  });

  it("surfaces transport errors from RegisterTool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"code":"permission_denied","message":"missing agent:tools:register"}', {
            status: 403,
          })
      )
    );
    await expect(
      exposeMcp({
        name: "demo",
        version: "0.1.0",
        callbackUrl: CALLBACK_URL,
        serverUrl: SERVER_URL,
        apiKey: API_KEY,
        tools: [
          { name: "y", description: "", input: z.object({}), handler: async () => ({}) },
        ],
      })
    ).rejects.toThrow(/HTTP 403/);
  });

  it("unregister() posts UnregisterTool and clears the local registry even on transport failure", async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/RegisterTool")) {
        return new Response(
          JSON.stringify({
            hmacSecret: "cd".repeat(32),
            registeredToolNames: ["demo.alpha"],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/UnregisterTool")) {
        return new Response('{"code":"unavailable","message":"down"}', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const handle = await exposeMcp({
      name: "demo",
      version: "0.1.0",
      callbackUrl: CALLBACK_URL,
      serverUrl: SERVER_URL,
      apiKey: API_KEY,
      tools: [
        { name: "alpha", description: "", input: z.object({}), handler: async () => ({}) },
      ],
    });
    expect(lookupLocal("demo.alpha")).toBeDefined();

    await expect(handle.unregister()).rejects.toThrow(/HTTP 503/);
    // Even when the server call fails, local handler closures must be detached.
    expect(lookupLocal("demo.alpha")).toBeUndefined();
  });

  it("unregister() is idempotent (second call is a no-op)", async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/RegisterTool")) {
        return new Response(
          JSON.stringify({
            hmacSecret: "ef".repeat(32),
            registeredToolNames: ["demo.beta"],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ removedCount: 1 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const handle = await exposeMcp({
      name: "demo",
      version: "0.1.0",
      callbackUrl: CALLBACK_URL,
      serverUrl: SERVER_URL,
      apiKey: API_KEY,
      tools: [
        { name: "beta", description: "", input: z.object({}), handler: async () => ({}) },
      ],
    });

    await handle.unregister();
    await handle.unregister();
    // RegisterTool + first UnregisterTool = 2 calls; second is a no-op.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
