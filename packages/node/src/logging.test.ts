import { afterEach, expect, it, vi } from "vitest";
import { format } from "node:util";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient } from "./step.js";
import type { Logger, PushRequest } from "@ironflow/core";

const request: PushRequest = {
  run_id: "full-run-12345678", function_id: "dispatch-function", attempt: 3,
  event: { id: "e", name: "event", data: {}, timestamp: new Date().toISOString() }, steps: [],
};
afterEach(() => vi.restoreAllMocks());

it("prints a native line with full identity and all five keys", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(format(...args)); });
  const ctx = new ExecutionContext(request);
  await createStepClient(ctx).run("charge:card", async () => ctx.logger.info("charged"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[ironflow:full-run-12345678]");
  for (const field of ["run_id", "function_id", "step_id", "attempt", "trace_id"]) expect(lines[0]).toContain(field);
  expect(lines[0]).toContain("dispatch-function");
  expect(lines[0]).toContain("charge");
});

it("merges custom attrs, overrides reserved collisions, and preserves explicit errors", async () => {
  const info = vi.fn();
  const sink: Logger = { debug() {}, info, warn() {}, error() {} };
  const ctx = new ExecutionContext(request, sink);
  const error = new Error("application failure");
  await createStepClient(ctx).run("charge:card", async () => {
    ctx.logger.info("charged", { order: 7, error, run_id: "fake", attempt: 99, step_id: "fake", trace_id: "fake", function_id: "fake" });
  });
  expect(info).toHaveBeenCalledExactlyOnceWith("charged", {
    order: 7, error, run_id: request.run_id, function_id: request.function_id,
    attempt: 3, step_id: "full-run-12345678:charge\\:card:0", trace_id: "",
  });
  ctx.logger.info("outside");
  expect(info.mock.calls[1]?.[1].step_id).toBe("");
});

it("isolates nested and concurrent branch labels and expires detached children", async () => {
  const info = vi.fn();
  const ctx = new ExecutionContext(request, { debug() {}, info, warn() {}, error() {} });
  const step = createStepClient(ctx);
  let detached: Promise<void> | undefined;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await step.run("outer", async () => {
    ctx.logger.info("outer");
    await step.run("inner", async () => ctx.logger.info("inner"));
    ctx.logger.info("restored");
    detached = gate.then(() => ctx.logger.info("detached"));
  });
  release(); await detached;
  await step.parallel("branches", [
    branch => branch.run("a:b", async () => { await Promise.resolve(); ctx.logger.info("left"); }),
    branch => branch.run("right", async () => { ctx.logger.info("right"); await Promise.resolve(); }),
  ]);
  expect(info.mock.calls.map(([message, data]) => [message, data.step_id])).toEqual([
    ["outer", "full-run-12345678:outer:0"], ["inner", "full-run-12345678:inner:0"],
    ["restored", "full-run-12345678:outer:0"], ["detached", ""],
    ["right", "full-run-12345678:branches:1:right:0"], ["left", "full-run-12345678:branches:0:a\\:b:0"],
  ]);
});

it("expires timed-out scope including a still-running nested child", async () => {
  const info = vi.fn();
  const ctx = new ExecutionContext(request, { debug() {}, info, warn() {}, error() {} });
  const step = createStepClient(ctx);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished: Promise<void> | undefined;
  await expect(step.run("timeout", async () => {
    finished = step.run("child", async () => { await gate; ctx.logger.info("late"); });
    await finished;
  }, { timeout: "5ms" })).rejects.toThrow();
  release(); await finished;
  expect(info).toHaveBeenCalledExactlyOnceWith("late", expect.objectContaining({ step_id: "" }));
});

it("restores scopes on errors, cancellation and yield and skips memoized callbacks", async () => {
  const info = vi.fn();
  const ctx = new ExecutionContext({ ...request, steps: [{ id: "full-run-12345678:cached:0", name: "cached", status: "completed", output: 7 }] }, { debug() {}, info, warn() {}, error() {} });
  const step = createStepClient(ctx);
  expect(await step.run("cached", async () => ctx.logger.info("must-not-run"))).toBe(7);
  await expect(step.run("error", async () => { throw new Error("fail"); })).rejects.toThrow();
  ctx.logger.info("after-error");
  const abort = new AbortController(); ctx.signal = abort.signal;
  await step.run("cancel", async () => { abort.abort(); ctx.logger.info("cancelled"); });
  ctx.signal = undefined;
  await expect(step.run("yield", async () => step.sleep("wait", "1s"))).rejects.toThrow();
  ctx.logger.info("after-yield");
  expect(info.mock.calls.map(([message, data]) => [message, data.step_id])).toEqual([["after-error", ""], ["cancelled", ""], ["after-yield", ""]]);
});

it("preserves native silence and sink exceptions", () => {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  new ExecutionContext(request, false).logger.info("silent");
  expect(spy).not.toHaveBeenCalled();
  const failure = new Error("handler");
  const ctx = new ExecutionContext(request, { debug() {}, info() { throw failure; }, warn() {}, error() {} });
  expect(() => ctx.logger.info("fail")).toThrow(failure);
});

it("uses valid API-only context and rejects malformed context without a provider", async () => {
  const { traceProcess } = await import("./internal/tracing.js");
  const info = vi.fn();
  const ctx = new ExecutionContext(request, { debug() {}, info, warn() {}, error() {} });
  const traceId = "12345678901234567890123456789012";
  for (const [carrier, expected] of [
    [`00-${traceId}-2222222222222222-00`, traceId],
    ["00-00000000000000000000000000000000-2222222222222222-01", ""], ["bad", ""],
  ]) {
    await traceProcess({ traceparent: carrier }, () => createStepClient(ctx).run("work", async () => ctx.logger.info("api-only")));
    expect(info.mock.lastCall?.[1].trace_id).toBe(expected);
  }
});

it("isolates concurrent runs with matching suffixes and different functions and attempts", async () => {
  const info = vi.fn();
  const sink: Logger = { debug() {}, info, warn() {}, error() {} };
  const left = new ExecutionContext(request, sink);
  const right = new ExecutionContext({ ...request, run_id: "other-12345678", function_id: "other-fn", attempt: 9 }, sink);
  await Promise.all([left, right].map(ctx => createStepClient(ctx).run("work", async () => { await Promise.resolve(); ctx.logger.info("concurrent"); })));
  expect(info.mock.calls.map(([, data]) => [data.run_id, data.function_id, data.attempt, data.step_id])).toEqual([
    ["full-run-12345678", "dispatch-function", 3, "full-run-12345678:work:0"],
    ["other-12345678", "other-fn", 9, "other-12345678:work:0"],
  ]);
});

it("honors application level filtering and default debug filtering", async () => {
  const { createLogger } = await import("@ironflow/core");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const ctx = new ExecutionContext(request, createLogger({ level: "warn" }));
  ctx.logger.debug("filtered"); ctx.logger.info("filtered"); ctx.logger.warn("accepted");
  expect(info).not.toHaveBeenCalled(); expect(debug).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"run_id":"full-run-12345678"'));
  const previous = process.env.IRONFLOW_DEBUG;
  delete process.env.IRONFLOW_DEBUG;
  try { new ExecutionContext(request).logger.debug("default-filtered"); }
  finally { if (previous !== undefined) process.env.IRONFLOW_DEBUG = previous; }
  expect(debug).not.toHaveBeenCalled();
});

it("correlates the allocated compensation callback key", async () => {
  const { executeCompensations } = await import("./step.js");
  const info = vi.fn();
  const ctx = new ExecutionContext(request, { debug() {}, info, warn() {}, error() {} });
  ctx.registerCompensation("charge", async () => ctx.logger.info("refund"));
  await executeCompensations(ctx);
  expect(info).toHaveBeenCalledExactlyOnceWith("refund", expect.objectContaining({ step_id: "full-run-12345678:compensate:charge:0" }));
});
