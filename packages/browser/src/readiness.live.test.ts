// @vitest-environment node
/**
 * Live test: reads one real seeded run back through the browser helpers (#2942).
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

interface Seed {
  functionId: string;
  pausedVersion: number;
  runId: string;
  stepId: string;
  entityId: string;
  beforeRun: string;
  afterStep: string;
  stepName: string;
  stepOutput: Record<string, unknown>;
  schemaEvent: string;
}

const STEP_EVENTS = ["run.created", "step.started", "step.completed", "run.status_changed"];

describe.skipIf(!SEED_PATH)("readiness — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = ironflow;
  client.configure({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
  });

  it("event-emit-batch and event-names", async () => {
    const suffix = `${Date.now()}`;
    const a = `browsersdk.readiness.a.${suffix}`;
    const b = `browsersdk.readiness.b.${suffix}`;
    const results = await client.triggerBatch([
      { event: a, data: { i: 1 } },
      { event: b, data: { i: 2 } },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.eventId).toBeTruthy();
    expect(results[0]!.eventId).not.toBe(results[1]!.eventId);

    const { names } = await client.listEventNames();
    const counts = Object.fromEntries(names.map((n) => [n.name, n.count]));
    expect(counts[a]).toBe(1);
    expect(counts[b]).toBe(1);
  });

  it("function-at-version", async () => {
    const entry = await client.getFunctionAtVersion(seed.functionId, seed.pausedVersion);
    expect(entry.functionId).toBe(seed.functionId);
    expect(entry.entityVersion).toBe(seed.pausedVersion);
    expect(entry.changeType).toBe("status_change");
    expect(entry.functionSnapshot?.status).toBe("paused");
    // The history read must differ from the current function.
    expect((await client.getFunction(seed.functionId)).status).toBe("active");
  });

  it("run-audit", async () => {
    const trail = await client.getAuditTrail(seed.runId);
    expect(trail.events.map((e) => e.eventType)).toEqual(STEP_EVENTS);
    expect(trail.totalCount).toBe(4);
    for (const e of trail.events) {
      expect(e.runId).toBe(seed.runId);
      expect(e.functionId).toBe(seed.functionId);
      expect(e.createdAt).toBeTruthy();
      if (e.eventType.startsWith("step.")) expect(e.stepId).toBe(seed.stepId);
    }

    const first = await client.getAuditTrail(seed.runId, { limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.totalCount).toBe(4);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.getAuditTrail(seed.runId, { limit: 2, cursor: first.nextCursor });
    expect([...first.events, ...second.events].map((e) => e.eventType)).toEqual(STEP_EVENTS);
  });

  it("run-streams", async () => {
    expect((await client.getRunStreams(seed.runId)).entityIds).toEqual([seed.entityId]);
  });

  it("tt-step-output-at", async () => {
    await expect(
      client.getStepOutputAt(seed.runId, seed.stepId, new Date(seed.beforeRun))
    ).rejects.toThrow(/not found/);
    const snap = await client.getStepOutputAt(seed.runId, seed.stepId, new Date(seed.afterStep));
    expect(snap.status).toBe("completed");
    expect(snap.output).toEqual(seed.stepOutput);
    const byName = await client.getStepOutputAt(seed.runId, seed.stepName, new Date(seed.afterStep));
    expect(byName.stepId).toBe(seed.stepId);
  });

  it("tt-run-state-at", async () => {
    const state = await client.getRunStateAt(seed.runId, new Date(seed.afterStep));
    expect(state.runId).toBe(seed.runId);
    expect(state.status).toBe("completed");
    expect(state.input).toEqual({});
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]!.stepId).toBe(seed.stepId);
    expect(state.steps[0]!.name).toBe(seed.stepName);
    expect(state.steps[0]!.output).toEqual(seed.stepOutput);
    expect(state.timestamp).toBeInstanceOf(Date);
  });

  it("tt-run-timeline", async () => {
    const events = await client.getRunTimeline(seed.runId);
    expect(events.map((e) => e.eventType)).toEqual(STEP_EVENTS);
    for (const e of events.filter((e) => e.eventType.startsWith("step."))) {
      expect(e.stepId).toBe(seed.stepId);
      expect(e.stepName).toBe(seed.stepName);
    }
    expect(events[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("schema-test-upcast", async () => {
    const data = { orderId: "o1" };
    const res = await client.schemas.testUpcast({ eventName: seed.schemaEvent, fromVersion: 1, toVersion: 3, data });
    expect(res.data).toEqual(data);
    expect(res.stepsApplied).toEqual([
      { fromVersion: 1, toVersion: 2, description: "upcast to v2" },
      { fromVersion: 2, toVersion: 3, description: "no schema registered for version 3" },
    ]);
  });

  it("pubsub-cg-manage", async () => {
    const name = `browsersdk-cg-${Date.now()}`;
    const pattern = `topic:browsersdk.cg.${name}`;
    await client.consumerGroups.create({ name, pattern, maxRedeliveries: 3 });
    const got = await client.consumerGroups.get(name);
    expect([got.name, got.pattern, got.maxRedeliveries]).toEqual([name, pattern, 3]);
    expect((await client.consumerGroups.list()).map((g) => g.name)).toContain(name);
    expect((await client.consumerGroups.update(name, { maxRedeliveries: 7 })).maxRedeliveries).toBe(7);
    expect((await client.consumerGroups.get(name)).maxRedeliveries).toBe(7);
    await client.consumerGroups.delete(name);
    await expect(client.consumerGroups.get(name)).rejects.toThrow(/not found/i);
  });

  it("webhook-secret-ops and webhook-deliveries", async () => {
    const server = process.env["IRONFLOW_TEST_SERVER"]!;
    const src = await client.webhooks.create({
      name: `browsersdk-wh-${Date.now()}`,
      eventPrefix: "browsersdk.wh",
      verifyHeader: "x-sig",
      verifyAlgorithm: "hmac-sha256",
      verifySecret: "s1",
    });
    expect(src.ingestToken).toBeTruthy();
    const deliver = async (secret: string, token: string, id: string) => {
      const body = JSON.stringify({ type: "browsersdk.wh", id, data: { k: 1 } });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (secret) headers["x-sig"] = createHmac("sha256", secret).update(body).digest("hex");
      const res = await fetch(`${server}/api/v1/webhooks/${src.id}?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers,
        body,
      });
      return res.status;
    };
    try {
      const t1 = src.ingestToken!;
      expect(await deliver("s1", t1, "d1")).toBe(200);

      expect((await client.webhooks.rotateSecret({ id: src.id, verifySecret: "s2" })).verifySecretPrevSet).toBe(true);
      expect(await deliver("s1", t1, "d2")).toBe(200); // grace window
      expect(await deliver("s2", t1, "d3")).toBe(200);

      expect((await client.webhooks.expireSecretPrev(src.id)).verifySecretPrevSet).toBeFalsy();
      expect(await deliver("s1", t1, "d4")).toBe(401);
      expect(await deliver("s2", t1, "d5")).toBe(200);

      const t2 = (await client.webhooks.rotateIngestToken(src.id)).ingestToken!;
      expect(t2).toBeTruthy();
      expect(t2).not.toBe(t1);
      expect(await deliver("s2", t1, "d6")).toBe(401);
      expect(await deliver("s2", t2, "d7")).toBe(200);

      expect((await client.webhooks.disableSignatureVerification({ id: src.id })).verifySecretSet).toBeFalsy();
      expect(await deliver("", t2, "d8")).toBe(200);

      const log = await client.webhooks.listDeliveries({ sourceId: src.id });
      // Newest first; a bad ingest token is rejected before the body is read.
      expect(log.totalCount).toBe(8);
      expect(log.deliveries.map((d) => [d.externalId ?? "", d.status, d.error ?? ""])).toEqual([
        ["d8", "accepted", ""],
        ["d7", "accepted", ""],
        ["", "rejected", "invalid ingest token"],
        ["d5", "accepted", ""],
        ["d4", "rejected", "signature mismatch"],
        ["d3", "accepted", ""],
        ["d2", "accepted", ""],
        ["d1", "accepted", ""],
      ]);
    } finally {
      await client.webhooks.deleteSource(src.id);
    }
  });
});
