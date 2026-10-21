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
  projections: Record<string, { name: string; eventId: string; seq: number }>;
  sqlProjection: string;
  holds: Record<string, { functionId: string; runId: string; eventId: string; noteStepId: string; spareRunId: string }>;
}

const STEP_EVENTS = ["run.created", "step.started", "step.completed", "run.status_changed"];

describe.skipIf(!SEED_PATH)("readiness — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = ironflow;
  client.configure({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
  });

  // #3051: these hold runs belong to the Browser suite alone, so the cases below
  // pauses and cancels them. Delete and redact are outside its boundary (ADR 0092). They run first, in order.
  const hold = SEED_PATH ? seed.holds["browser"]! : ({} as Seed["holds"][string]);
  const ids = (runs: { id: string }[]) => runs.map((r) => r.id).sort();

  it("run-get", async () => {
    const run = await client.getRun(seed.runId);
    expect(run).toMatchObject({ id: seed.runId, functionId: seed.functionId, status: "completed", input: {}, output: seed.stepOutput });
    expect(run.endedAt).toBeInstanceOf(Date);
  });

  it("run-list", async () => {
    const own = await client.listRuns({ functionId: seed.functionId });
    expect(ids(own.runs)).toEqual([seed.runId]);
    expect(own.totalCount).toBe(1);
    const both = [hold.runId, hold.spareRunId].sort();
    const waiting = await client.listRuns({ functionId: hold.functionId, status: "waiting" });
    expect(ids(waiting.runs)).toEqual(both);
    expect(waiting.totalCount).toBe(2);
    const first = await client.listRuns({ functionId: hold.functionId, limit: 1 });
    expect(first.runs).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.listRuns({ functionId: hold.functionId, limit: 1, cursor: first.nextCursor });
    expect(ids([...first.runs, ...second.runs])).toEqual(both);
  });

  it("run-steps", async () => {
    const seeded = await client.getRunSteps(seed.runId);
    expect(seeded.count).toBe(1);
    expect(seeded.steps[0]).toMatchObject({ stepId: seed.stepId, runId: seed.runId, status: "completed", output: seed.stepOutput });
    const held = await client.getRunSteps(hold.runId);
    expect(held.steps).toHaveLength(2);
    expect(held.steps[0]).toMatchObject({ id: hold.noteStepId, status: "completed", output: { sdk: "browser" } });
    expect(held.steps[1]).toMatchObject({
      stepType: "wait_for_event",
      status: "waiting",
      waitEventName: `readiness.never.${hold.functionId}`,
    });
    expect(held.steps[1]!.waitTimeout).toBeTruthy();
  });

  it("run-pause", async () => {
    // A waiting run has no next step boundary, so it is held at once.
    expect(await client.pauseRun(hold.runId)).toEqual({ status: "paused" });
    expect((await client.getRun(hold.runId)).status).toBe("paused");
  });

  it("run-paused-state", async () => {
    const state = await client.getPausedState(hold.runId);
    expect(state.pauseReason).toBe("injection");
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({ id: hold.noteStepId, status: "completed", injected: false, completedAt: expect.stringMatching(/^\d{4}-/), output: { sdk: "browser" } });
  });

  // The wait step is still open, so resume puts the run back on its wait.
  it("run-resume", async () => {
    expect(await client.resumeRun(hold.runId)).toMatchObject({ id: hold.runId, status: "waiting" });
  });

  it("run-cancel", async () => {
    expect(await client.cancelRun(hold.runId, "readiness")).toMatchObject({ id: hold.runId, status: "cancelled" });
    expect((await client.getRun(hold.runId)).status).toBe("cancelled");
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

  it("event-emit, event-list and event-get", async () => {
    const name = `browsersdk.readiness.emit.${Date.now()}`;
    const res = await client.emit(name, { i: 7 });
    // No function listens on a unique name, so the event is stored with no runs.
    expect(res.eventId).toBeTruthy();
    expect(res.runIds).toEqual([]);

    const page = await client.listEvents({ name, limit: 5 });
    expect(page.count).toBe(1);
    expect(page.events.map((e) => e.id)).toEqual([res.eventId]);

    const got = await client.getEvent(res.eventId);
    expect(got.id).toBe(res.eventId);
    expect(got.name).toBe(name);
    expect(got.data).toEqual({ i: 7 });
  });

  it("event-emit-sync", async () => {
    const name = `browsersdk.readiness.sync.${Date.now()}`;
    const results = await client.emitSync(name, { i: 1 }, { timeout: 5000 });
    expect(results).toEqual([]);
    expect((await client.listEvents({ name })).count).toBe(1);
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

  // #3003: the browser reads its own seeded projection. The operator calls
  // (pause, rebuild, delete, SQL create, batch wait) are outside its boundary.
  it("proj-get, proj-list and proj-status", async () => {
    const { name, seq } = seed.projections["browser"]!;
    const got = await client.getProjection<{ count: number }>(name);
    expect(got).toMatchObject({ name, mode: "managed", status: "active", state: { count: 2 } });
    expect(got.lastEventSeq).toBeGreaterThanOrEqual(seq);
    const list = await client.listProjections();
    expect(list.find((p) => p.name === name)?.status).toBe("active");
    const status = await client.getProjectionStatus(name);
    expect(status).toMatchObject({ name, mode: "managed", status: "active", lastEventSeq: got.lastEventSeq });
  });

  it("proj-wait-for-event", async () => {
    const { name, eventId, seq } = seed.projections["browser"]!;
    const w = await client.waitForEvent(eventId, name, { timeoutMs: 5000 });
    expect(w).toMatchObject({ caughtUp: true, targetSeq: seq, behindByEvents: 0, mode: "managed" });
  });

  it("proj-catchup", async () => {
    const { name, seq } = seed.projections["browser"]!;
    const w = await client.waitForProjectionCatchup(name, { minSeq: seq, timeoutMs: 5000 });
    expect(w).toMatchObject({ caughtUp: true, timedOut: false, targetSeq: seq });
    const far = seq + 1_000_000;
    const late = await client.waitForProjectionCatchup(name, { minSeq: far, timeoutMs: 200 });
    expect(late).toMatchObject({ caughtUp: false, timedOut: true, targetSeq: far });
    let last;
    for await (const p of client.waitForProjectionCatchupStream(name, { minSeq: seq, timeoutMs: 5000 })) {
      last = p;
      if (p.terminal) break;
    }
    expect(last).toMatchObject({ terminal: true, caughtUp: true, targetSeq: BigInt(seq) });
  });

  it("proj-sql-query", async () => {
    const res = await client.querySQLProjection(seed.sqlProjection);
    expect(res).toMatchObject({ columns: ["k", "v"], rows: [["a", "1"]], typedRows: [["a", "1"]], totalCount: 1 });
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
