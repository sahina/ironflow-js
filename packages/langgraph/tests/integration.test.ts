/**
 * Integration test for IronflowSaver — ship-blocking per #598.
 *
 * Requires a running Ironflow server.
 *   ./build/ironflow serve
 *   IRONFLOW_INTEGRATION=1 pnpm test
 *
 * Verifies the durable crash-resume narrative:
 *   1. Run a real LangGraph cycle for N steps with IronflowSaver.
 *   2. Throw mid-cycle (simulated crash).
 *   3. Construct a fresh saver instance against the same server.
 *   4. Resume from last checkpoint — assert state continues, no duplicates.
 *   5. Re-run with same idempotency context — assert no duplicate writes
 *      via server-side dedup (replayed put = no-op).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import { IronflowClient } from "@ironflow/node";
import { IronflowSaver } from "../src/saver.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";

const State = Annotation.Root({
  counter: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  history: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

describe.skipIf(!INTEGRATION)("IronflowSaver — crash-resume integration", () => {
  let client: IronflowClient;
  const cleanupThreads: string[] = [];

  beforeAll(async () => {
    const ok = await fetch(`${SERVER_URL}/health`).then((r) => r.ok).catch(() => false);
    if (!ok) {
      throw new Error(
        `Ironflow server not reachable at ${SERVER_URL}. Start with: ./build/ironflow serve`
      );
    }
    client = new IronflowClient({ serverUrl: SERVER_URL });
  });

  afterEach(async () => {
    for (const tid of cleanupThreads) {
      try {
        const saver = new IronflowSaver({ client });
        await saver.deleteThread(tid);
      } catch {
        // ignore cleanup errors
      }
    }
    cleanupThreads.length = 0;
  });

  it("resumes from last checkpoint after a simulated crash", async () => {
    const threadId = `lg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cleanupThreads.push(threadId);

    let crashAt = 3;
    const buildGraph = (saver: IronflowSaver) =>
      new StateGraph(State)
        .addNode("step", (state: typeof State.State) => {
          const next = state.counter + 1;
          if (next === crashAt) throw new Error("simulated crash");
          return { counter: next, history: [`step-${next}`] };
        })
        .addEdge(START, "step")
        .addConditionalEdges("step", (s) => (s.counter >= 5 ? END : "step"))
        .compile({ checkpointer: saver });

    const saver1 = new IronflowSaver({ client });
    const graph1 = buildGraph(saver1);
    await expect(
      graph1.invoke({ counter: 0, history: [] }, { configurable: { thread_id: threadId } })
    ).rejects.toThrow(/simulated crash/);

    const saver2 = new IronflowSaver({ client });
    const tuple = await saver2.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.channel_values).toMatchObject({ counter: 2 });

    crashAt = -1;
    const graph2 = buildGraph(saver2);
    const final = await graph2.invoke(null, { configurable: { thread_id: threadId } });
    expect(final.counter).toBe(5);
    expect(final.history).toEqual(["step-1", "step-2", "step-3", "step-4", "step-5"]);
  }, 30_000);

  it("idempotent put dedups on replay (same checkpoint_id)", async () => {
    const threadId = `lg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cleanupThreads.push(threadId);

    const saver = new IronflowSaver({ client });
    const cp = {
      v: 4,
      id: "fixed-cp-1",
      ts: new Date().toISOString(),
      channel_values: { x: 1 },
      channel_versions: {},
      versions_seen: {},
    };
    const meta = { source: "loop" as const, step: 0, parents: {} };
    const cfg = { configurable: { thread_id: threadId, checkpoint_ns: "" } };

    await saver.put(cfg, cp, meta, {});
    await saver.put(cfg, cp, meta, {});

    const list: string[] = [];
    for await (const t of saver.list(cfg)) list.push(t.checkpoint.id);
    expect(list).toEqual(["fixed-cp-1"]);
  }, 15_000);

  it("list returns checkpoints in descending order across a 3-step graph", async () => {
    const threadId = `lg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cleanupThreads.push(threadId);

    const saver = new IronflowSaver({ client });
    const graph = new StateGraph(State)
      .addNode("inc", (s: typeof State.State) => ({
        counter: s.counter + 1,
        history: [`tick-${s.counter + 1}`],
      }))
      .addEdge(START, "inc")
      .addConditionalEdges("inc", (s) => (s.counter >= 3 ? END : "inc"))
      .compile({ checkpointer: saver });

    const cfg = { configurable: { thread_id: threadId } };
    await graph.invoke({ counter: 0, history: [] }, cfg);

    const ids: string[] = [];
    for await (const t of saver.list(cfg)) ids.push(t.checkpoint.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
    // First yielded checkpoint must be the latest (matches getTuple).
    const latest = await saver.getTuple(cfg);
    expect(ids[0]).toBe(latest!.checkpoint.id);
  }, 20_000);
});
