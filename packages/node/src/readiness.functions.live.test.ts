/**
 * Live test: the functions group (#3003) through the Node client, on one push
 * function this test registers, serves and deletes. The server has no signing
 * key, so the handler accepts unsigned requests.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createFunction } from "./function.js";
import { serve } from "./serve.js";
import type { Run } from "./index.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];
// A run through a push endpoint outlasts the 5 second default on a slow machine.
const LONG = 40_000;

describe.skipIf(!SEED_PATH)("readiness functions — live server", () => {
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });
  const id = `readiness-fn-node-${Date.now()}`;
  const fn = createFunction(
    { id, triggers: [{ event: `readiness.functions.${id}` }] },
    async ({ event }) => ({ echoed: event.data }),
  );
  const handler = serve({ functions: [fn], logger: false });
  let server: Server;
  let endpointUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => {
    server.close();
  });

  const registration = (description: string) => ({
    id,
    name: "Readiness functions (Node)",
    description,
    triggers: [{ event: `readiness.functions.${id}` }],
    retry: { maxAttempts: 4, initialDelayMs: 2000, backoffFactor: 3, maxDelayMs: 60000 },
    timeoutMs: 45000,
    concurrency: { limit: 2, key: "who" },
    preferredMode: "push" as const,
    endpointUrl,
    metadata: { team: "readiness" },
  });

  it("function-register and function-get", async () => {
    expect(await client.registerFunction(registration("first"))).toEqual({ created: true });
    expect(await client.getFunction(id)).toMatchObject({
      id,
      name: "Readiness functions (Node)",
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

    // A second registration updates in place: version 2, new description.
    expect(await client.registerFunction(registration("second"))).toEqual({ created: false });
    expect(await client.getFunction(id)).toMatchObject({ version: 2, description: "second" });
  }, LONG);

  it("function-list", async () => {
    const listed = (await client.listFunctions()) as Array<Record<string, unknown>>;
    expect(listed.find((f) => f["id"] === id)).toMatchObject({
      name: "Readiness functions (Node)",
      status: "active",
      execution_mode: "push",
      retry_attempts: 4,
      timeout_ms: 45000,
    });
  }, LONG);

  it("function-invoke", async () => {
    const result = await client.invoke(id, { data: { who: "José" } });
    expect(result).toMatchObject({ functionId: id, status: "completed", output: { echoed: { who: "José" } } });
    expect(result.runId).toBeTruthy();
    // Typed with the package's public Run: the timestamps it declares are the strings getRun returns.
    const run: Run = await client.getRun(result.runId);
    expect(run).toMatchObject({ functionId: id, input: { who: "José" } });
    expect(typeof run.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(run.createdAt))).toBe(false);
    await expect(client.invoke(`${id}-missing`, { data: {} })).rejects.toMatchObject({ code: "not_found" });
  }, LONG);

  it("function-status", async () => {
    const before = await client.getFunction(id);
    expect(await client.updateFunctionStatus(id, "paused")).toMatchObject({ status: "paused", version: before.version + 1 });
    expect((await client.getFunction(id)).status).toBe("paused");
    // A paused function starts no run for its trigger event.
    expect((await client.emit(`readiness.functions.${id}`, {})).runIds).toEqual([]);
    expect(await client.updateFunctionStatus(id, "active")).toMatchObject({ status: "active", version: before.version + 2 });
    expect((await client.emit(`readiness.functions.${id}`, {})).runIds).toHaveLength(1);
  }, LONG);

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
  }, LONG);

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
  }, LONG);

  it("function-delete", async () => {
    await client.deleteFunction(id);
    await expect(client.getFunction(id)).rejects.toMatchObject({ code: "not_found" });
    const listed = (await client.listFunctions()) as Array<Record<string, unknown>>;
    expect(listed.some((f) => f["id"] === id)).toBe(false);
    // The history outlives the function and ends with the delete.
    const hist = await client.listFunctionHistory(id, { limit: 1 });
    expect(hist.entries.map((e) => e.changeType)).toEqual(["delete"]);
    await expect(client.deleteFunction(id)).rejects.toMatchObject({ code: "not_found" });
  }, LONG);
});
