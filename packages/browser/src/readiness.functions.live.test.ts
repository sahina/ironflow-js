// @vitest-environment node
/**
 * Live test: the functions group (#3003) through the browser client, on one
 * push function. The browser has no register call (function-register is
 * not-applicable), so the test registers it over raw Connect JSON and serves it
 * with a hand-written push endpoint, which is all the push protocol asks for.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ironflow as client } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness functions — live server", () => {
  const serverUrl = process.env["IRONFLOW_TEST_SERVER"]!;
  const apiKey = process.env["IRONFLOW_TEST_API_KEY"];
  client.configure({ serverUrl, auth: { apiKey } });
  const id = `readiness-fn-browser-${Date.now()}`;
  let server: Server;
  let endpointUrl = "";

  // Setup only: the browser client has no register call.
  const register = async (description: string) => {
    const res = await fetch(`${serverUrl}/ironflow.v1.IronflowService/RegisterFunction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        id,
        name: "Readiness functions (browser)",
        description,
        triggers: [{ event: `readiness.functions.${id}` }],
        retry: { maxAttempts: 4, initialDelayMs: 2000, backoffFactor: 3, maxDelayMs: 60000 },
        timeoutMs: 45000,
        concurrency: { limit: 2, key: "who" },
        preferredMode: "push",
        endpointUrl,
        metadata: { team: "readiness" },
      }),
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const push = JSON.parse(raw) as { event: { data: unknown } };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "completed", result: { echoed: push.event.data } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await register("first");
  });
  afterAll(() => {
    server.close();
  });

  it("function-get", async () => {
    expect(await client.getFunction(id)).toMatchObject({
      id,
      name: "Readiness functions (browser)",
      description: "first",
      triggers: [{ event: `readiness.functions.${id}` }],
      retry: { maxAttempts: 4, initialDelayMs: 2000, backoffFactor: 3, maxDelayMs: 60000 },
      timeoutMs: 45000,
      concurrency: { limit: 2, key: "who" },
      preferredMode: "push",
      endpointUrl,
      status: "active",
      version: 1,
      metadata: { team: "readiness" },
      createdAt: expect.stringMatching(/^\d{4}-/),
      updatedAt: expect.stringMatching(/^\d{4}-/),
    });
  });

  it("function-list", async () => {
    const listed = (await client.listFunctions()) as Array<Record<string, unknown>>;
    expect(listed.find((f) => f["id"] === id)).toMatchObject({
      name: "Readiness functions (browser)",
      status: "active",
      execution_mode: "push",
      retry_attempts: 4,
      timeout_ms: 45000,
    });
  });

  it("function-invoke", async () => {
    const result = await client.invoke(id, { data: { who: "José" } });
    expect(result).toMatchObject({ functionId: id, status: "completed", output: { echoed: { who: "José" } } });
    expect(result.runId).toBeTruthy();
    expect(await client.getRun(result.runId)).toMatchObject({ functionId: id, input: { who: "José" } });
    await expect(client.invoke(`${id}-missing`, { data: {} })).rejects.toMatchObject({ code: "not_found" });
  }, 40_000);

  it("function-status", async () => {
    await register("second");
    const before = await client.getFunction(id);
    expect(await client.updateFunctionStatus(id, "paused")).toMatchObject({ status: "paused", version: before.version + 1 });
    expect((await client.getFunction(id)).status).toBe("paused");
    // A paused function starts no run for its trigger event.
    expect((await client.emit(`readiness.functions.${id}`, {})).runIds).toEqual([]);
    expect(await client.updateFunctionStatus(id, "active")).toMatchObject({ status: "active", version: before.version + 2 });
    expect((await client.emit(`readiness.functions.${id}`, {})).runIds).toHaveLength(1);
  });

  it("function-history", async () => {
    const hist = await client.listFunctionHistory(id, { limit: 100 });
    // Newest first: activate, pause, re-register, register.
    expect(hist.entries.map((e) => e.changeType)).toEqual(["status_change", "status_change", "update", "created"]);
    expect(hist.entries.map((e) => e.functionSnapshot?.status)).toEqual(["active", "paused", "active", "active"]);
    expect(hist.hasMore).toBe(false);
    hist.entries.forEach((e, i) => {
      expect(e).toMatchObject({ functionId: id, eventId: expect.any(String), recordedAt: expect.stringMatching(/^\d{4}-/) });
      if (i > 0) expect(e.entityVersion).toBe(hist.entries[i - 1]!.entityVersion - 1);
    });
    expect(hist.entries[0]!.functionSnapshot?.description).toBe("second");
    expect(hist.entries[3]!.functionSnapshot?.description).toBe("first");

    const page1 = await client.listFunctionHistory(id, { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await client.listFunctionHistory(id, { limit: 2, fromVersion: page1.entries[1]!.entityVersion });
    expect(page2.entries.map((e) => e.eventId)).toEqual(hist.entries.slice(2).map((e) => e.eventId));
    expect(page2.hasMore).toBe(false);
  });

  it("function-rollback", async () => {
    await client.updateFunctionStatus(id, "paused");
    const before = await client.getFunction(id);
    const hist = await client.listFunctionHistory(id, { limit: 100 });
    const created = hist.entries[hist.entries.length - 1]!;
    expect(created.changeType).toBe("created");

    const back = await client.rollbackFunction(id, created.entityVersion, "readiness rollback");
    expect(back).toMatchObject({ description: "first", status: "active", version: before.version + 1 });
    expect(await client.getFunction(id)).toMatchObject({ description: "first", status: "active" });
    const newest = (await client.listFunctionHistory(id, { limit: 1 })).entries[0]!;
    expect(newest).toMatchObject({ changeType: "rollback", changeReason: "readiness rollback" });
    expect(newest.functionSnapshot?.description).toBe("first");
    await expect(client.rollbackFunction(id, 9999)).rejects.toMatchObject({ code: "not_found" });
  });

  it("function-delete", async () => {
    await client.deleteFunction(id);
    await expect(client.getFunction(id)).rejects.toMatchObject({ code: "not_found" });
    const listed = (await client.listFunctions()) as Array<Record<string, unknown>>;
    expect(listed.some((f) => f["id"] === id)).toBe(false);
    // The history outlives the function and ends with the delete.
    const hist = await client.listFunctionHistory(id, { limit: 1 });
    expect(hist.entries.map((e) => e.changeType)).toEqual(["delete"]);
    await expect(client.deleteFunction(id)).rejects.toMatchObject({ code: "not_found" });
  });
});
