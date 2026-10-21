/**
 * Live test: the agent-tools group (#3003) through the Node client. Tool
 * registration is proven by `make test-conformance`. Skips unless
 * IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exposeMcp } from "./agent/index.js";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness agent tools — live server", () => {
  const serverUrl = process.env["IRONFLOW_TEST_SERVER"]!;
  const apiKey = process.env["IRONFLOW_TEST_API_KEY"];
  const client = new IronflowClient({ serverUrl, apiKey });

  it("agent-tool-list and agent-tool-unregister", async () => {
    // The server checks a callback URL's scheme and, for an IP literal, its range.
    // A hostname passes, and nothing here is dispatched.
    const name = `nodesdk${Date.now()}`;
    const input = z.object({ id: z.string() });
    const handle = await exposeMcp({
      name,
      version: "1.0.0",
      serverUrl,
      apiKey,
      callbackUrl: "https://tools.example.test/api/ironflow/ironflow/agent-tools/dispatch",
      tools: [
        { name: "lookup", description: "Look up an order", input, handler: async () => ({}) },
        { name: "refund", description: "Refund an order", input, handler: async () => ({}) },
      ],
    });

    // The registry is shared with the other SDKs' tools, so look only at this agent's.
    const mine = async () =>
      (await client.agentTools.list()).tools.filter((t) => t.qualifiedName.startsWith(`${name}.`));

    try {
      const tools = await mine();
      expect(tools.map((t) => t.qualifiedName).sort()).toEqual([`${name}.lookup`, `${name}.refund`]);
      const lookup = tools.find((t) => t.qualifiedName === `${name}.lookup`)!;
      expect(lookup.description).toBe("Look up an order");
      expect(JSON.parse(lookup.inputSchemaJson)).toMatchObject({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      });
      expect(lookup.requiredScopes).toEqual([]);
    } finally {
      await handle.unregister();
    }
    expect(await mine()).toEqual([]);
  });
});
