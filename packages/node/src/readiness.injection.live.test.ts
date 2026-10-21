/**
 * Live test: the scoped-injection group (#3003) through the Node client. Each
 * SDK has its own seeded function with a completed run to patch, and a run held
 * in a one-hour sleep behind two failed steps. Following an injected value
 * through later steps after a resume is left to the engine tests, because the
 * held run cannot get past its sleep here.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

interface Seed {
  stepOutput: Record<string, unknown>;
  groups: {
    injection: Record<
      string,
      { doneRunId: string; doneStepId: string; holdRunId: string; patchStepId: string; injectStepId: string; sleepStepId: string }
    >;
  };
}

describe.skipIf(!SEED_PATH)("readiness injection — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });
  const runs = () => seed.groups.injection["node"]!;
  const step = async (runId: string, id: string) => (await client.getRunSteps(runId)).steps.find((s) => s.id === id)!;

  it("step-patch", async () => {
    const patched = { n: 43, who: "patched" };
    await client.patchStep(runs().doneStepId, patched, "readiness patch");
    expect(await step(runs().doneRunId, runs().doneStepId)).toMatchObject({
      output: patched,
      originalOutput: seed.stepOutput,
      patchedAt: expect.stringMatching(/^\d{4}-/),
    });

    // A failed step becomes completed and loses its error.
    expect(await step(runs().holdRunId, runs().patchStepId)).toMatchObject({ status: "failed", error: expect.anything() });
    await client.patchStep(runs().patchStepId, patched, "readiness recover");
    const recovered = await step(runs().holdRunId, runs().patchStepId);
    expect(recovered).toMatchObject({ status: "completed", output: patched, patchedAt: expect.stringMatching(/^\d{4}-/) });
    expect(recovered.error ?? null).toBeNull();

    // Only completed and failed steps can be patched.
    await expect(client.patchStep(runs().sleepStepId, patched)).rejects.toMatchObject({ code: "failed_precondition" });
    await expect(client.patchStep("no-such-step", patched)).rejects.toMatchObject({ code: "not_found" });
  });

  it("step-inject-output", async () => {
    // A run that is not paused for injection refuses it.
    await expect(client.injectStepOutput(runs().doneRunId, runs().doneStepId, {})).rejects.toMatchObject({ code: "failed_precondition" });
    expect(await client.pauseRun(runs().holdRunId)).toEqual({ status: "paused" });
    const state = await client.getPausedState(runs().holdRunId);
    expect(state.steps.find((s) => s.id === runs().injectStepId)).toMatchObject({ status: "failed", error: expect.anything() });
    const write = (await client.getRunSteps(runs().holdRunId)).steps.find(
      (s) => s.status === "completed" && !s.patchedAt && s.originalOutput == null,
    )!;

    // A completed step: the call returns the output it replaced.
    const injected = { n: 7, who: "José injected" };
    expect(await client.injectStepOutput(runs().holdRunId, write.id, injected, "readiness inject")).toEqual({
      stepId: write.id,
      previousOutput: seed.stepOutput,
    });
    expect(await step(runs().holdRunId, write.id)).toMatchObject({ output: injected, originalOutput: seed.stepOutput });

    // A failed step becomes completed and loses its error.
    await client.injectStepOutput(runs().holdRunId, runs().injectStepId, injected, "readiness recover");
    const recovered = await step(runs().holdRunId, runs().injectStepId);
    expect(recovered).toMatchObject({ status: "completed", output: injected });
    expect(recovered.error ?? null).toBeNull();
    const after = await client.getPausedState(runs().holdRunId);
    expect(after.steps.find((s) => s.id === runs().injectStepId)).toMatchObject({ injected: true, status: "completed", output: injected });

    // The function records, so each injection is a step.injected audit event.
    await vi.waitFor(
      async () => expect((await client.getAuditTrail(runs().holdRunId, { eventType: "step.injected" })).events).toHaveLength(2),
      { timeout: 10_000 },
    );
  }, 40_000);
});
