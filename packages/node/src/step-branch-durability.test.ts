import { describe, it, expect, vi } from "vitest";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient } from "./step.js";
import type { Logger, PushRequest } from "@ironflow/core";

// Regression tests for #1671: step.map / step.parallel branches are durable
// only if the callback uses the scoped step client it is handed. Both shapes
// typecheck and both appear to work, so the SDK warns about the inert one.

function harness(): { step: ReturnType<typeof createStepClient>; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const request: PushRequest = {
    run_id: "run-durability",
    function_id: "fn-durability",
    attempt: 1,
    event: {
      id: "evt-1",
      name: "test.event",
      data: {},
      timestamp: "2024-01-01T00:00:00Z",
    },
    steps: [],
  };
  return { step: createStepClient(new ExecutionContext(request, logger)), warn };
}

const warnings = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map((c) => String(c[0]));

describe("branch durability warning", () => {
  it("warns when map branches ignore the scoped step client", async () => {
    const { step, warn } = harness();

    const out = await step.map("ingest", ["a", "b"], async (item) => item.toUpperCase());

    expect(out).toEqual(["A", "B"]);
    expect(warnings(warn)).toEqual([
      expect.stringContaining("ingest: 2/2 branches did not use the scoped"),
    ]);
  });

  it("stays quiet when map branches use the scoped step client", async () => {
    const { step, warn } = harness();

    const out = await step.map("ingest", ["a", "b"], async (item, docStep) =>
      docStep.run(`upper:${item}`, async () => item.toUpperCase()),
    );

    expect(out).toEqual(["A", "B"]);
    expect(warnings(warn)).toEqual([]);
  });

  it("stays quiet when only some branches short-circuit", async () => {
    const { step, warn } = harness();

    // A mixed result means the author already knows about the scoped client;
    // warning here would fire on every run of correct conditional code.
    await step.map("mixed", ["a", "b", "c"], async (item, docStep) =>
      item === "b" ? item : docStep.run(`upper:${item}`, async () => item.toUpperCase()),
    );

    expect(warnings(warn)).toEqual([]);
  });

  it("does not warn for a branch whose only work is a nested map", async () => {
    const { step, warn } = harness();

    await step.parallel("outer", [
      (branchStep) =>
        branchStep.map("inner", ["a"], async (item, itemStep) =>
          itemStep.run(`upper:${item}`, async () => item.toUpperCase()),
        ),
    ]);

    expect(warnings(warn)).toEqual([]);
  });

  it("does not warn when a branch's nested map has no items", async () => {
    const { step, warn } = harness();

    // The empty inner map never calls createBranchContext, so marking the
    // parent has to happen on entry to executeParallel, not per branch.
    await step.parallel("outer", [
      (branchStep) =>
        branchStep.map("inner", [] as string[], async (item, itemStep) =>
          itemStep.run(`upper:${item}`, async () => item.toUpperCase()),
        ),
    ]);

    expect(warnings(warn)).toEqual([]);
  });

  it("stays quiet for an empty collection", async () => {
    const { step, warn } = harness();

    await step.map("empty", [] as string[], async (item) => item);

    expect(warnings(warn)).toEqual([]);
  });

  it("warns once on the concurrency-limited path", async () => {
    const { step, warn } = harness();

    await step.map("conc", ["a", "b", "c"], async (item) => item, { concurrency: 2 });

    expect(warnings(warn)).toEqual([
      expect.stringContaining("conc: 3/3 branches did not use the scoped"),
    ]);
  });

  it("flags branches that reach for the outer step client", async () => {
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const ctx = new ExecutionContext(
      {
        run_id: "run-outer",
        function_id: "fn-outer",
        attempt: 1,
        event: { id: "evt-1", name: "test.event", data: {}, timestamp: "2024-01-01T00:00:00Z" },
        steps: [],
      },
      logger,
    );
    const step = createStepClient(ctx);

    // These DO record steps — just at the function's top level, outside the
    // parallel scope. The warning must not claim they recorded nothing.
    await step.parallel("p", [
      () => step.run("branch-a", async () => "A"),
      () => step.run("branch-b", async () => "B"),
    ]);

    expect(warnings(warn)).toEqual([
      expect.stringContaining("p: 2/2 branches did not use the scoped"),
    ]);
    expect(warnings(warn)[0]).not.toContain("recorded no durable step");
  });

  it("re-executes a completed branch step when migrated to the scoped client", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // A run that already completed `branch-a` under the OUTER-client id.
    const ctx = new ExecutionContext(
      {
        run_id: "r1",
        function_id: "fn",
        attempt: 2,
        event: { id: "evt-1", name: "test.event", data: {}, timestamp: "2024-01-01T00:00:00Z" },
        steps: [
          { id: "r1:branch-a:0", name: "branch-a", status: "completed", output: "MEMOIZED" },
        ],
      },
      logger,
    );
    const step = createStepClient(ctx);
    let sideEffects = 0;

    const out = await step.parallel("p", [
      (branchStep) =>
        branchStep.run("branch-a", async () => {
          sideEffects += 1;
          return "RE-EXECUTED";
        }),
    ]);

    // Pins the migration hazard the docs warn about: the scoped id is
    // `r1:p:0:branch-a:0`, preferLegacyStepId early-returns because the
    // colon-free name escapes to itself, so the memoized row is missed.
    expect(out).toEqual(["RE-EXECUTED"]);
    expect(sideEffects).toBe(1);
  });

  it("warns once per name, not once per nested fan-out", async () => {
    const { step, warn } = harness();

    // Without the per-name dedupe this emits one "inner" line per outer item.
    await step.map("outer", ["a", "b", "c"], async (item, itemStep) =>
      itemStep.parallel("inner", [async () => item, async () => item]),
    );

    expect(warnings(warn)).toEqual([
      expect.stringContaining("inner: 2/2 branches did not use the scoped"),
    ]);
  });

  it("still reports two distinct bad call sites", async () => {
    const { step, warn } = harness();

    await step.map("first", ["a"], async (item) => item);
    await step.map("second", ["a"], async (item) => item);

    expect(warnings(warn)).toHaveLength(2);
  });

  it("stays quiet when the caller opts out", async () => {
    const { step, warn } = harness();

    await step.map("normalize", ["a", "b"], async (item) => item.toUpperCase(), {
      expectScopedClient: false,
    });

    expect(warnings(warn)).toEqual([]);
  });

  it("does not blame a branch that threw", async () => {
    const { step, warn } = harness();

    await step.map(
      "flaky",
      ["a", "b"],
      async (item) => {
        throw new Error(`boom ${item}`);
      },
      { onError: "allSettled" },
    );

    expect(warnings(warn)).toEqual([]);
  });
});
