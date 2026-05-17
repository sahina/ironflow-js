/**
 * Ship-blocking integration tests for `ironflow.agents.readMemory()`.
 *
 * Requires:
 *   1. A running Ironflow server: `./build/ironflow serve --dev`
 *   2. A registered fixture agent that writes to a projection (default
 *      `doc-processor-agent` writing to projection `doc-processor-memory`).
 *      Override via FIXTURE_FN / FIXTURE_PROJECTION / FIXTURE_DOC_ID_KEY env.
 *   3. `IRONFLOW_INTEGRATION=1`
 *
 * Run:
 *   IRONFLOW_INTEGRATION=1 pnpm -C sdk/js/browser test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ironflow } from "../../src/index.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";
const FIXTURE_FN = process.env["FIXTURE_FN"] ?? "doc-processor-agent";
const FIXTURE_PROJECTION =
  process.env["FIXTURE_PROJECTION"] ?? "doc-processor-memory";
// Key in the projection state map used to look up the appended doc. The
// doc-processor projection stores `{[docId]: DocState}`.
const FIXTURE_DOC_ID_KEY = process.env["FIXTURE_DOC_ID_KEY"] ?? "docId";

interface DocState {
  docId: string;
  status: string;
  category?: string;
}

type MemoryState = Record<string, DocState>;

describe.skipIf(!INTEGRATION)("agents.readMemory — integration", () => {
  beforeAll(async () => {
    const ok = await fetch(`${SERVER_URL}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) {
      throw new Error(
        `Ironflow server not reachable at ${SERVER_URL}. Start with: ./build/ironflow serve --dev`
      );
    }

    const fnList = await fetch(`${SERVER_URL}/api/v1/functions`).then((r) =>
      r.json()
    );
    const exists = (fnList.functions ?? []).some(
      (f: { id: string; name?: string }) =>
        f.id === FIXTURE_FN || f.name === FIXTURE_FN
    );
    if (!exists) {
      throw new Error(
        `Test fixture function "${FIXTURE_FN}" not registered. Register a memory-writing agent or set FIXTURE_FN env.`
      );
    }

    ironflow.configure({
      serverUrl: SERVER_URL,
      transport: "connectrpc",
      environment: "default",
    });
    await ironflow.connect();
  });

  afterAll(() => {
    ironflow.disconnect();
  });

  it("round-trip: invoke → readMemory shows the agent's write", async () => {
    const docId = `it-doc-${Date.now()}`;
    await ironflow.agents.invoke<unknown>(
      FIXTURE_FN,
      { [FIXTURE_DOC_ID_KEY]: docId },
      { timeoutMs: 30_000 }
    );

    // Eventual consistency: poll briefly because the projection cursor
    // can lag the run.completed event by a few ms. 5s budget is generous
    // for a healthy local server.
    let seen: DocState | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await ironflow.agents.readMemory<MemoryState>(
        FIXTURE_PROJECTION
      );
      seen = result.state[docId];
      if (seen) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(seen).toBeDefined();
    expect(seen!.docId).toBe(docId);
  });

  it("returns version + caughtUp on a successful read", async () => {
    const result = await ironflow.agents.readMemory<MemoryState>(
      FIXTURE_PROJECTION
    );
    expect(result.caughtUp).toBe(true);
    expect(typeof result.version).toBe("number");
    expect(result.state).toBeDefined();
  });

  it("404 on unknown projection name", async () => {
    await expect(
      ironflow.agents.readMemory(`nonexistent-projection-${Date.now()}`)
    ).rejects.toMatchObject({ name: "IronflowError" });
  });

  it("AbortSignal cancels before any network I/O", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await ironflow.agents
      .readMemory(FIXTURE_PROJECTION, { signal: ctrl.signal })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  // D-S2-5 hardening: the env header is the tenant boundary; reading a
  // projection registered in env A from env B should not leak state.
  // Issued via raw fetch because the browser SDK exposes a singleton
  // client (no parallel-env construction). Verifies the store-layer
  // envFilter on `GET /api/v1/projections/{name}`.
  it("cross-env: reading FIXTURE_PROJECTION from a foreign env returns 404", async () => {
    const foreignEnv = `nonexistent-env-${Date.now()}`;
    const url = `${SERVER_URL}/api/v1/projections/${encodeURIComponent(
      FIXTURE_PROJECTION
    )}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Ironflow-Environment": foreignEnv },
    });
    expect(response.status).toBe(404);
  });
});
