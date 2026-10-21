/**
 * Live test: reads one real seeded run back through the Node helpers (#2942).
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createFunction } from "./function.js";
import { createProjection } from "./projection.js";
import { createWorker } from "./worker.js";
import { isRedacted } from "./index.js";

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
  partitionProjection: string;
  partitions: string[];
  schemaEvent: string;
  projections: Record<string, { name: string; eventId: string; seq: number }>;
  holds: Record<string, { functionId: string; runId: string; eventId: string; noteStepId: string; spareRunId: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEP_EVENTS = ["run.created", "step.started", "step.completed", "run.status_changed"];

describe.skipIf(!SEED_PATH)("readiness — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });

  // #3051: these hold runs belong to the Node suite alone, so the cases below
  // pauses, cancels, redacts and deletes them. They run first, in order.
  const hold = SEED_PATH ? seed.holds["node"]! : ({} as Seed["holds"][string]);
  const ids = (runs: { id: string }[]) => runs.map((r) => r.id).sort();

  it("run-get", async () => {
    const run = await client.getRun(seed.runId);
    expect(run).toMatchObject({ id: seed.runId, functionId: seed.functionId, status: "completed", input: {}, output: seed.stepOutput });
    expect(run.endedAt).toBeTruthy();
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
    expect(held.steps[0]).toMatchObject({ id: hold.noteStepId, status: "completed", output: { sdk: "node" } });
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
    expect(state.steps[0]).toMatchObject({ id: hold.noteStepId, status: "completed", injected: false, completedAt: expect.stringMatching(/^\d{4}-/), output: { sdk: "node" } });
  });

  // The wait step is still open, so resume puts the run back on its wait.
  it("run-resume", async () => {
    expect(await client.resumeRun(hold.runId)).toMatchObject({ id: hold.runId, status: "waiting" });
  });

  it("run-cancel", async () => {
    expect(await client.cancelRun(hold.runId, "readiness")).toMatchObject({ id: hold.runId, status: "cancelled" });
    expect((await client.getRun(hold.runId)).status).toBe("cancelled");
  });

  it("payload-redact", async () => {
    const { runId, eventId, noteStepId } = hold;
    await client.redactStep(noteStepId);
    await client.redactRun(runId);
    await client.redactEvent(eventId);
    expect(isRedacted((await client.getRunSteps(runId)).steps[0]!.output)).toBe(true);
    expect(isRedacted((await client.getRun(runId)).input)).toBe(true);
    expect(isRedacted((await client.getEvent(eventId)).data)).toBe(true);
  });

  it("run-delete", async () => {
    await client.deleteRun(hold.runId);
    await expect(client.getRun(hold.runId)).rejects.toThrow(/not found/i);
    await client.cancelRun(hold.spareRunId, "readiness");
    expect(await client.deleteRuns({ functionId: hold.functionId })).toBe(1);
    expect(await client.deleteRuns({ functionId: hold.functionId })).toBe(0);
  });

  it("event-emit-batch and event-names", async () => {
    const suffix = `${Date.now()}`;
    const a = `nodesdk.readiness.a.${suffix}`;
    const b = `nodesdk.readiness.b.${suffix}`;
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
    const name = `nodesdk.readiness.emit.${Date.now()}`;
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
    const name = `nodesdk.readiness.sync.${Date.now()}`;
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

  it("proj-partitions", async () => {
    const res = await client.projections.listPartitions(seed.partitionProjection);
    expect([...res.partitions].sort()).toEqual(seed.partitions);
    expect(res.returned).toBe(seed.partitions.length);
  });

  // #3003: this projection belongs to the Node suite alone, so the cases below
  // may pause, rebuild and delete it. Vitest runs them in order.
  const own = () => seed.projections["node"]!;
  const statusOf = async () => (await client.projections.getStatus(own().name)).status;

  it("proj-get, proj-list and proj-status", async () => {
    const { name, seq } = own();
    const got = await client.projections.get<{ count: number }>(name);
    expect(got).toMatchObject({ name, mode: "managed", status: "active", state: { count: 2 } });
    expect(got.lastEventSeq).toBeGreaterThanOrEqual(seq);
    const list = await client.projections.list();
    expect(list.find((p) => p.name === name)?.status).toBe("active");
    const status = await client.projections.getStatus(name);
    expect(status).toMatchObject({ name, mode: "managed", status: "active", lastEventSeq: got.lastEventSeq });
  });

  it("proj-wait-for-event", async () => {
    const { name, eventId, seq } = own();
    const w = await client.projections.waitForEvent(eventId, name, { timeoutMs: 5000 });
    expect(w).toMatchObject({ caughtUp: true, targetSeq: seq, behindByEvents: 0, mode: "managed" });
  });

  it("proj-catchup", async () => {
    const { name, seq } = own();
    const w = await client.projections.waitForCatchup(name, { minSeq: seq, timeoutMs: 5000 });
    expect(w).toMatchObject({ caughtUp: true, timedOut: false, targetSeq: seq });
    expect(w.currentSeq).toBeGreaterThanOrEqual(seq);
    const far = seq + 1_000_000;
    const late = await client.projections.waitForCatchup(name, { minSeq: far, timeoutMs: 200 });
    expect(late).toMatchObject({ caughtUp: false, timedOut: true, targetSeq: far });
  });

  it("proj-catchup-batch", async () => {
    const { name, seq } = own();
    const missing = `readiness-missing-${Date.now()}`;
    const res = await client.projections.waitForCatchupBatch(
      [
        { name, minSeq: seq },
        { name: missing, minSeq: 1 },
      ],
      { timeoutMs: 5000 },
    );
    expect(res).toHaveLength(2);
    expect(res[0]!.result?.caughtUp).toBe(true);
    expect(res[0]!.error).toBeFalsy();
    expect(res[1]!.error).toMatch(/not found/);
  });

  it("proj-pause and proj-resume", async () => {
    await client.projections.pause(own().name);
    expect(await statusOf()).toBe("paused");
    await client.projections.resume(own().name);
    expect(await statusOf()).toBe("active");
  });

  // No runner is connected, so the rebuild stays running until it is cancelled.
  it("proj-rebuild, proj-rebuild-status and proj-rebuild-cancel", async () => {
    const { name } = own();
    const job = await client.projections.rebuild(name);
    expect(job).toMatchObject({ name, status: "running" });
    expect(job.startedAt).toBeTruthy();
    expect(await statusOf()).toBe("rebuilding");
    expect(await client.projections.getRebuildJob(name)).toMatchObject({ name, status: "running" });
    await client.projections.cancelRebuild(name);
    expect((await client.projections.getRebuildJob(name)).status).toBe("cancelled");
    expect(await statusOf()).toBe("active");
  });

  // delete is the SDK's unregister: the REST route runs the UnregisterProjection handler.
  it("proj-delete and proj-unregister", async () => {
    await client.projections.delete(own().name);
    await expect(client.projections.get(own().name)).rejects.toThrow(/not found/i);
  });

  it("proj-sql-create and proj-sql-query", async () => {
    const name = `readiness_sql_node_${Date.now()}`;
    const event = `readiness.sql.${name}`;
    const created = await client.sqlProjections.create({
      name,
      tableSql: `CREATE TABLE proj_${name} (k TEXT PRIMARY KEY, v TEXT)`,
      events: [event],
      eventHandlers: {
        [event]: `INSERT INTO proj_${name} (k, v) VALUES (:data.k, :data.v) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      },
    });
    expect(created).toEqual({ name, status: "created" });
    try {
      await client.emit(event, { k: "a", v: "1" });
      let res = await client.sqlProjections.query(name);
      for (let i = 0; i < 75 && res.totalCount === 0; i++) {
        await sleep(200);
        res = await client.sqlProjections.query(name);
      }
      expect(res).toMatchObject({ columns: ["k", "v"], rows: [["a", "1"]], typedRows: [["a", "1"]], totalCount: 1 });
    } finally {
      await client.projections.delete(name);
    }
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
    const name = `nodesdk-cg-${Date.now()}`;
    const pattern = `topic:nodesdk.cg.${name}`;
    await client.consumerGroups.create({ name, pattern, maxRedeliveries: 3 });
    const got = await client.consumerGroups.get(name);
    expect([got.name, got.pattern, got.maxRedeliveries]).toEqual([name, pattern, 3]);
    expect((await client.consumerGroups.list()).map((g) => g.name)).toContain(name);
    expect((await client.consumerGroups.update(name, { maxRedeliveries: 7 })).maxRedeliveries).toBe(7);
    expect((await client.consumerGroups.get(name)).maxRedeliveries).toBe(7);
    await client.consumerGroups.delete(name);
    await expect(client.consumerGroups.get(name)).rejects.toThrow(/not found/i);
  });

  // Two runners of one external projection: one holds the lease past the 30s
  // TTL (renew); stopping it hands over well before expiry (release). The
  // standby retries every 5s with jitter.
  it("proj-runner-lease", async () => {
    const name = `nodesdk-lease-${Date.now()}`;
    const event = `nodesdk.lease.${name}`;
    const seen: Record<string, number[]> = { a: [], b: [] };
    const start = (id: string) => {
      // A worker with no functions never starts its runners (registration
      // needs one function), so each worker carries a no-op function.
      const worker = createWorker({
        serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
        apiKey: process.env["IRONFLOW_TEST_API_KEY"],
        logger: false,
        functions: [createFunction({ id: `${name}-noop`, triggers: [{ event: `${name}.noop` }] }, async () => null)],
        projections: [
          createProjection<unknown, unknown>({
            name,
            events: [event],
            mode: "external",
            handler: async (e: { data: unknown }) => {
              seen[id]!.push(Number((e.data as { i: number }).i));
            },
          }),
        ],
      });
      void worker.start(); // never resolves
      return worker;
    };
    let i = 0;
    const emitUntil = async (cond: () => boolean, withinMs: number, everyMs: number) => {
      for (const end = Date.now() + withinMs; Date.now() < end; await sleep(everyMs)) {
        await client.emit(event, { i: ++i });
        if (cond()) return true;
      }
      return cond();
    };

    const a = start("a");
    let b: ReturnType<typeof start> | undefined;
    try {
      expect(await emitUntil(() => seen.a!.length > 0, 30_000, 500)).toBe(true);
      b = start("b");
      await emitUntil(() => false, 35_000, 2_000); // past one TTL
      const last = i;
      for (const end = Date.now() + 10_000; Date.now() < end && !seen.a!.includes(last); ) await sleep(200);
      expect(seen.a).toContain(last);
      expect(seen.b).toEqual([]); // renew kept the lease with a

      await a.drain();
      const afterStop = seen.a!.length;
      expect(await emitUntil(() => seen.b!.length > 0, 15_000, 1_000)).toBe(true); // release freed it
      expect(seen.a!.length).toBe(afterStop);
    } finally {
      await a.drain();
      await b?.drain();
    }
  }, 120_000);
  it("webhook-secret-ops and webhook-deliveries", async () => {
    const server = process.env["IRONFLOW_TEST_SERVER"]!;
    const src = await client.webhooks.create({
      name: `nodesdk-wh-${Date.now()}`,
      eventPrefix: "nodesdk.wh",
      verifyHeader: "x-sig",
      verifyAlgorithm: "hmac-sha256",
      verifySecret: "s1",
    });
    expect(src.ingestToken).toBeTruthy();
    const deliver = async (secret: string, token: string, id: string) => {
      const body = JSON.stringify({ type: "nodesdk.wh", id, data: { k: 1 } });
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
