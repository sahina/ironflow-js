import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertDefined } from "./internal/assert-defined.js";

// Define YieldSignal inline to avoid triggering core imports during testing
interface SleepYieldInfo {
  step_id: string;
  type: "sleep";
  until: string;
}

interface WaitEventYieldInfo {
  step_id: string;
  type: "wait_for_event";
  event_filter: {
    event: string;
    match?: string;
    timeout?: string;
  };
}

type YieldInfo = SleepYieldInfo | WaitEventYieldInfo;

class YieldSignal extends Error {
  readonly yieldInfo: YieldInfo;
  constructor(yieldInfo: YieldInfo) {
    super("Yield signal");
    this.name = "YieldSignal";
    this.yieldInfo = yieldInfo;
  }
}

function isYieldSignal(error: unknown): error is YieldSignal {
  return error instanceof YieldSignal;
}

// Inline interfaces for testing (avoiding imports)
interface StepResult {
  id: string;
  name: string;
  type: string;
  status: "completed" | "failed";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  output?: unknown;
  error?: {
    message: string;
    retryable: boolean;
    stack?: string;
  };
}

interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

interface StepClient {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  sleep: (name: string, duration: string | number) => Promise<void>;
  sleepUntil: (name: string, until: Date | string) => Promise<void>;
  waitForEvent: <T = unknown>(name: string, filter: { event: string; match?: string; timeout?: string | number }) => Promise<T>;
  parallel: <T extends unknown[]>(
    name: string,
    branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
    options?: { concurrency?: number; onError?: "failFast" | "allSettled" }
  ) => Promise<T>;
  map: <T, R>(
    name: string,
    items: T[],
    fn: (item: T, step: StepClient, index: number) => Promise<R>,
    options?: { concurrency?: number; onError?: "failFast" | "allSettled" }
  ) => Promise<R[]>;
}

// Mock StepContext for testing
interface MockStepContext {
  runId: string;
  logger: Logger;
  stepCounters: Map<string, number>;
  completedSteps: Map<string, { output: unknown }>;
  executedSteps: StepResult[];
  resumeContext: { stepId: string; type: "sleep" | "wait_for_event"; data?: unknown } | null;
  resumeProcessed: boolean;
  generateStepId(name: string): string;
  shouldSkipStep(stepId: string): boolean;
  getMemoizedOutput<T>(stepId: string): T | undefined;
  isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean;
  getResumeData<T>(): T | undefined;
  markResumeProcessed(): void;
  recordStep(step: StepResult): void;
  createBranchContext(parallelName: string, branchIndex: number): MockBranchContext;
}

// Mock BranchContext
interface MockBranchContext {
  runId: string;
  logger: Logger;
  prefix: string;
  stepCounters: Map<string, number>;
  generateStepId(name: string): string;
  shouldSkipStep(stepId: string): boolean;
  getMemoizedOutput<T>(stepId: string): T | undefined;
  isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean;
  getResumeData<T>(): T | undefined;
  markResumeProcessed(): void;
  recordStep(step: StepResult): void;
  createBranchContext(parallelName: string, branchIndex: number): MockBranchContext;
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockContext(overrides: Partial<MockStepContext> = {}): MockStepContext {
  const stepCounters = overrides.stepCounters ?? new Map<string, number>();
  const completedSteps = overrides.completedSteps ?? new Map<string, { output: unknown }>();
  const executedSteps = overrides.executedSteps ?? [];
  const logger = overrides.logger ?? createMockLogger();

  const ctx: MockStepContext = {
    runId: overrides.runId ?? "run-123",
    logger,
    stepCounters,
    completedSteps,
    executedSteps,
    resumeContext: overrides.resumeContext ?? null,
    resumeProcessed: overrides.resumeProcessed ?? false,

    generateStepId(name: string): string {
      const count = stepCounters.get(name) ?? 0;
      stepCounters.set(name, count + 1);
      return `${this.runId}:${name}:${count}`;
    },

    shouldSkipStep(stepId: string): boolean {
      return completedSteps.has(stepId);
    },

    getMemoizedOutput<T>(stepId: string): T | undefined {
      const step = completedSteps.get(stepId);
      return step?.output as T | undefined;
    },

    isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean {
      return this.resumeContext?.stepId === stepId && this.resumeContext?.type === type;
    },

    getResumeData<T>(): T | undefined {
      return this.resumeContext?.data as T | undefined;
    },

    markResumeProcessed(): void {
      this.resumeProcessed = true;
    },

    recordStep(step: StepResult): void {
      executedSteps.push(step);
    },

    createBranchContext(parallelName: string, branchIndex: number): MockBranchContext {
      return createMockBranchContext(ctx, `${parallelName}:${branchIndex}`);
    },
  };

  return ctx;
}

function createMockBranchContext(parent: MockStepContext, prefix: string): MockBranchContext {
  const stepCounters = new Map<string, number>();

  const branch: MockBranchContext = {
    runId: parent.runId,
    logger: parent.logger,
    prefix,
    stepCounters,

    generateStepId(name: string): string {
      const count = stepCounters.get(name) ?? 0;
      stepCounters.set(name, count + 1);
      return `${parent.runId}:${prefix}:${name}:${count}`;
    },

    shouldSkipStep(stepId: string): boolean {
      return parent.shouldSkipStep(stepId);
    },

    getMemoizedOutput<T>(stepId: string): T | undefined {
      return parent.getMemoizedOutput<T>(stepId);
    },

    isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean {
      return parent.isResumingFrom(stepId, type);
    },

    getResumeData<T>(): T | undefined {
      return parent.getResumeData<T>();
    },

    markResumeProcessed(): void {
      parent.markResumeProcessed();
    },

    recordStep(step: StepResult): void {
      parent.recordStep(step);
    },

    createBranchContext(parallelName: string, branchIndex: number): MockBranchContext {
      return createMockBranchContext(parent, `${prefix}:${parallelName}:${branchIndex}`);
    },
  };

  return branch;
}

// Inline step client implementation for testing
function createStepClient(ctx: MockStepContext | MockBranchContext): StepClient {
  return {
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const stepId = ctx.generateStepId(name);

      // Check memoization
      if (ctx.shouldSkipStep(stepId)) {
        ctx.logger.debug(`Step memoized: ${name}`, { stepId });
        return ctx.getMemoizedOutput<T>(stepId)!;
      }

      // Execute the step
      const startedAt = new Date();
      ctx.logger.debug(`Step starting: ${name}`, { stepId });

      try {
        const output = await fn();
        const endedAt = new Date();
        const durationMs = endedAt.getTime() - startedAt.getTime();

        const result: StepResult = {
          id: stepId,
          name,
          type: "invoke",
          status: "completed",
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_ms: durationMs,
          output,
        };
        ctx.recordStep(result);

        ctx.logger.debug(`Step completed: ${name}`, { stepId, durationMs });
        return output;
      } catch (error) {
        // Re-throw YieldSignal
        if (error instanceof YieldSignal) {
          throw error;
        }

        const endedAt = new Date();
        const durationMs = endedAt.getTime() - startedAt.getTime();
        const errorMessage = error instanceof Error ? error.message : String(error);

        const result: StepResult = {
          id: stepId,
          name,
          type: "invoke",
          status: "failed",
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_ms: durationMs,
          error: {
            message: errorMessage,
            retryable: false,
            stack: error instanceof Error ? error.stack : undefined,
          },
        };
        ctx.recordStep(result);

        throw error;
      }
    },

    async sleep(name: string, duration: string | number): Promise<void> {
      const stepId = ctx.generateStepId(name);

      if (ctx.isResumingFrom(stepId, "sleep")) {
        ctx.logger.debug(`Sleep resumed: ${name}`, { stepId });
        ctx.markResumeProcessed();
        return;
      }

      if (ctx.shouldSkipStep(stepId)) {
        ctx.logger.debug(`Sleep memoized: ${name}`, { stepId });
        return;
      }

      // Calculate wake time
      const ms = typeof duration === "number" ? duration : parseDuration(duration);
      const wakeAt = new Date(Date.now() + ms);

      throw new YieldSignal({
        step_id: stepId,
        type: "sleep",
        until: wakeAt.toISOString(),
      });
    },

    async sleepUntil(name: string, until: Date | string): Promise<void> {
      const stepId = ctx.generateStepId(name);

      if (ctx.isResumingFrom(stepId, "sleep")) {
        ctx.logger.debug(`SleepUntil resumed: ${name}`, { stepId });
        ctx.markResumeProcessed();
        return;
      }

      if (ctx.shouldSkipStep(stepId)) {
        ctx.logger.debug(`SleepUntil memoized: ${name}`, { stepId });
        return;
      }

      const wakeAt = typeof until === "string" ? new Date(until) : until;

      throw new YieldSignal({
        step_id: stepId,
        type: "sleep",
        until: wakeAt.toISOString(),
      });
    },

    async waitForEvent<T = unknown>(name: string, filter: { event: string; match?: string; timeout?: string | number }): Promise<T> {
      const stepId = ctx.generateStepId(name);

      if (ctx.isResumingFrom(stepId, "wait_for_event")) {
        ctx.logger.debug(`WaitForEvent resumed: ${name}`, { stepId });
        ctx.markResumeProcessed();
        const resumeData = ctx.getResumeData<T>();
        if (resumeData) {
          return resumeData;
        }
      }

      if (ctx.shouldSkipStep(stepId)) {
        ctx.logger.debug(`WaitForEvent memoized: ${name}`, { stepId });
        const output = ctx.getMemoizedOutput<T>(stepId);
        if (output) {
          return output;
        }
      }

      const timeout = filter.timeout
        ? typeof filter.timeout === "string"
          ? filter.timeout
          : `${filter.timeout}ms`
        : "7d";

      throw new YieldSignal({
        step_id: stepId,
        type: "wait_for_event",
        event_filter: {
          event: filter.event,
          match: filter.match,
          timeout,
        },
      });
    },

    async parallel<T extends unknown[]>(
      name: string,
      branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
      options: { concurrency?: number; onError?: "failFast" | "allSettled" } = {}
    ): Promise<T> {
      const { concurrency, onError = "failFast" } = options;

      ctx.logger.debug(`Starting parallel execution: ${name}`, {
        branchCount: branches.length,
        concurrency,
        onError,
      });

      const results: (unknown | Error)[] = new Array(branches.length);
      let firstError: Error | null = null;
      let yieldSignal: YieldSignal | null = null;
      const cancelled = { value: false };

      // Pre-create branch contexts and step clients
      const branchStepClients = branches.map((_, index) => {
        const branchCtx = (ctx as MockStepContext).createBranchContext
          ? (ctx as MockStepContext).createBranchContext(name, index)
          : (ctx as MockBranchContext).createBranchContext(name, index);
        return createStepClient(branchCtx);
      });

      const executeBranch = async (index: number): Promise<void> => {
        if (cancelled.value && onError === "failFast") return;

        try {
          const scopedStep = branchStepClients[index]!;
          const branchFn = branches[index] as (step: StepClient) => Promise<unknown>;
          const result = await branchFn(scopedStep);
          results[index] = result;
        } catch (error) {
          if (error instanceof YieldSignal) {
            yieldSignal = error;
            cancelled.value = true;
          } else {
            const err = error instanceof Error ? error : new Error(String(error));
            results[index] = err;

            if (onError === "failFast" && !firstError) {
              firstError = err;
              cancelled.value = true;
            }
          }
        }
      };

      // Execute with optional concurrency limit
      if (concurrency && concurrency > 0) {
        const pending: Promise<void>[] = [];

        for (let i = 0; i < branches.length; i++) {
          if (cancelled.value && onError === "failFast") break;

          if (pending.length >= concurrency) {
            await Promise.race(pending);
          }

          const promise = executeBranch(i).finally(() => {
            const idx = pending.indexOf(promise);
            if (idx !== -1) pending.splice(idx, 1);
          });
          pending.push(promise);
        }

        await Promise.all(pending);
      } else {
        await Promise.all(branches.map((_, i) => executeBranch(i)));
      }

      // Handle yield signal
      if (yieldSignal) {
        throw yieldSignal;
      }

      // Handle errors based on mode
      if (onError === "failFast" && firstError) {
        throw firstError;
      }

      if (onError !== "allSettled") {
        const errorIndex = results.findIndex((r) => r instanceof Error);
        if (errorIndex !== -1) {
          throw results[errorIndex];
        }
      }

      ctx.logger.debug(`Parallel execution completed: ${name}`, {
        successCount: results.filter((r) => !(r instanceof Error)).length,
        errorCount: results.filter((r) => r instanceof Error).length,
      });

      return results as T;
    },

    async map<T, R>(
      name: string,
      items: T[],
      fn: (item: T, step: StepClient, index: number) => Promise<R>,
      options: { concurrency?: number; onError?: "failFast" | "allSettled" } = {}
    ): Promise<R[]> {
      ctx.logger.debug(`Starting map execution: ${name}`, {
        itemCount: items.length,
        options,
      });

      const branches = items.map((item, index) => {
        return async (step: StepClient): Promise<R> => {
          return await fn(item, step, index);
        };
      });

      return this.parallel(name, branches as unknown as ((step: StepClient) => Promise<unknown>)[], options) as Promise<R[]>;
    },
  };
}

// Helper to parse duration strings
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 0;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

describe("YieldSignal", () => {
  it("should create a sleep yield signal", () => {
    const signal = new YieldSignal({
      step_id: "step-123",
      type: "sleep",
      until: new Date(Date.now() + 3600000).toISOString(),
    });

    expect(signal.name).toBe("YieldSignal");
    expect(signal.yieldInfo.type).toBe("sleep");
    expect(signal.yieldInfo.step_id).toBe("step-123");
  });

  it("should create a wait_for_event yield signal", () => {
    const signal = new YieldSignal({
      step_id: "step-456",
      type: "wait_for_event",
      event_filter: {
        event: "approval.received",
        match: "data.orderId == '123'",
        timeout: "24h",
      },
    });

    expect(signal.yieldInfo.type).toBe("wait_for_event");
    if (signal.yieldInfo.type === "wait_for_event") {
      expect(signal.yieldInfo.event_filter.event).toBe("approval.received");
      expect(signal.yieldInfo.event_filter.match).toBe("data.orderId == '123'");
    }
  });
});

describe("isYieldSignal", () => {
  it("should return true for YieldSignal instances", () => {
    const signal = new YieldSignal({
      step_id: "step-1",
      type: "sleep",
      until: new Date().toISOString(),
    });

    expect(isYieldSignal(signal)).toBe(true);
  });

  it("should return false for regular errors", () => {
    expect(isYieldSignal(new Error("test"))).toBe(false);
  });

  it("should return false for non-error values", () => {
    expect(isYieldSignal(null)).toBe(false);
    expect(isYieldSignal(undefined)).toBe(false);
    expect(isYieldSignal("string")).toBe(false);
    expect(isYieldSignal(123)).toBe(false);
    expect(isYieldSignal({})).toBe(false);
  });
});

describe("step.run", () => {
  let ctx: MockStepContext;
  let step: StepClient;

  beforeEach(() => {
    ctx = createMockContext();
    step = createStepClient(ctx);
  });

  it("should execute and record a successful step", async () => {
    const result = await step.run("myStep", async () => {
      return { data: "test" };
    });

    expect(result).toEqual({ data: "test" });
    expect(ctx.executedSteps).toHaveLength(1);
    expect(ctx.executedSteps[0]!.status).toBe("completed");
    expect(ctx.executedSteps[0]!.name).toBe("myStep");
    expect(ctx.executedSteps[0]!.output).toEqual({ data: "test" });
  });

  it("should record failed steps", async () => {
    await expect(
      step.run("failingStep", async () => {
        throw new Error("Step failed");
      })
    ).rejects.toThrow("Step failed");

    expect(ctx.executedSteps).toHaveLength(1);
    expect(ctx.executedSteps[0]!.status).toBe("failed");
    expect(ctx.executedSteps[0]!.error?.message).toBe("Step failed");
  });

  it("should re-throw YieldSignal without recording as failed", async () => {
    const yieldSignal = new YieldSignal({
      step_id: "step-1",
      type: "sleep",
      until: new Date().toISOString(),
    });

    await expect(
      step.run("yieldingStep", async () => {
        throw yieldSignal;
      })
    ).rejects.toThrow(yieldSignal);

    // YieldSignal should not be recorded as a failed step
    expect(ctx.executedSteps).toHaveLength(0);
  });

  it("should generate unique step IDs", async () => {
    await step.run("stepA", async () => "a1");
    await step.run("stepA", async () => "a2");
    await step.run("stepB", async () => "b1");

    expect(ctx.executedSteps[0]!.id).toBe("run-123:stepA:0");
    expect(ctx.executedSteps[1]!.id).toBe("run-123:stepA:1");
    expect(ctx.executedSteps[2]!.id).toBe("run-123:stepB:0");
  });
});

describe("memoization", () => {
  it("should return cached output without re-executing", async () => {
    const executionCount = { value: 0 };

    const completedSteps = new Map<string, { output: unknown }>();
    completedSteps.set("run-123:cachedStep:0", { output: "cached result" });

    const ctx = createMockContext({ completedSteps });
    const step = createStepClient(ctx);

    const result = await step.run("cachedStep", async () => {
      executionCount.value++;
      return "new result";
    });

    expect(result).toBe("cached result");
    expect(executionCount.value).toBe(0); // Function was not executed
    expect(ctx.executedSteps).toHaveLength(0); // No new steps recorded
  });

  it("should execute if step is not memoized", async () => {
    const ctx = createMockContext();
    const step = createStepClient(ctx);

    const result = await step.run("newStep", async () => "executed");

    expect(result).toBe("executed");
    expect(ctx.executedSteps).toHaveLength(1);
  });

  it("should handle memoized sleep", async () => {
    const completedSteps = new Map<string, { output: unknown }>();
    completedSteps.set("run-123:sleepStep:0", { output: undefined });

    const ctx = createMockContext({ completedSteps });
    const step = createStepClient(ctx);

    // Should not throw
    await step.sleep("sleepStep", "1h");
  });

  it("should handle memoized waitForEvent", async () => {
    const completedSteps = new Map<string, { output: unknown }>();
    completedSteps.set("run-123:waitStep:0", {
      output: { id: "evt-1", name: "test.event", data: { result: true } },
    });

    const ctx = createMockContext({ completedSteps });
    const step = createStepClient(ctx);

    const event = await step.waitForEvent("waitStep", { event: "test.event" });
    expect(event).toEqual({ id: "evt-1", name: "test.event", data: { result: true } });
  });
});

describe("sleep", () => {
  it("should throw YieldSignal with correct info", async () => {
    const ctx = createMockContext();
    const step = createStepClient(ctx);

    try {
      await step.sleep("mySleep", "1h");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(isYieldSignal(error)).toBe(true);
      const signal = error as YieldSignal;
      expect(signal.yieldInfo.type).toBe("sleep");
      expect(signal.yieldInfo.step_id).toBe("run-123:mySleep:0");
    }
  });

  it("should resume from sleep when resume context matches", async () => {
    const ctx = createMockContext({
      resumeContext: { stepId: "run-123:mySleep:0", type: "sleep" },
    });
    const step = createStepClient(ctx);

    // Should not throw - should resume
    await step.sleep("mySleep", "1h");
    expect(ctx.resumeProcessed).toBe(true);
  });
});

describe("sleepUntil", () => {
  it("should throw YieldSignal with target date", async () => {
    const ctx = createMockContext();
    const step = createStepClient(ctx);
    const targetDate = new Date("2025-12-31T23:59:59Z");

    try {
      await step.sleepUntil("countdown", targetDate);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(isYieldSignal(error)).toBe(true);
      const signal = error as YieldSignal;
      if (signal.yieldInfo.type === "sleep") {
        expect(signal.yieldInfo.until).toBe("2025-12-31T23:59:59.000Z");
      }
    }
  });

  it("should accept string date", async () => {
    const ctx = createMockContext();
    const step = createStepClient(ctx);

    try {
      await step.sleepUntil("countdown", "2025-12-31T23:59:59Z");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(isYieldSignal(error)).toBe(true);
    }
  });
});

describe("waitForEvent", () => {
  it("should throw YieldSignal with event filter", async () => {
    const ctx = createMockContext();
    const step = createStepClient(ctx);

    try {
      await step.waitForEvent("waitApproval", {
        event: "order.approved",
        match: "data.orderId == '123'",
        timeout: "24h",
      });
      expect.fail("Should have thrown");
    } catch (error) {
      expect(isYieldSignal(error)).toBe(true);
      const signal = error as YieldSignal;
      expect(signal.yieldInfo.type).toBe("wait_for_event");
      if (signal.yieldInfo.type === "wait_for_event") {
        expect(signal.yieldInfo.event_filter.event).toBe("order.approved");
        expect(signal.yieldInfo.event_filter.match).toBe("data.orderId == '123'");
        expect(signal.yieldInfo.event_filter.timeout).toBe("24h");
      }
    }
  });

  it("should resume with event data", async () => {
    const eventData = { id: "evt-match", name: "order.approved", data: { approved: true } };
    const ctx = createMockContext({
      resumeContext: { stepId: "run-123:waitApproval:0", type: "wait_for_event", data: eventData },
    });
    const step = createStepClient(ctx);

    const result = await step.waitForEvent("waitApproval", { event: "order.approved" });
    expect(result).toEqual(eventData);
    expect(ctx.resumeProcessed).toBe(true);
  });
});

describe("parallel", () => {
  let ctx: MockStepContext;
  let step: StepClient;

  beforeEach(() => {
    ctx = createMockContext();
    step = createStepClient(ctx);
  });

  describe("failFast mode (default)", () => {
    it("should execute all branches in parallel", async () => {
      const executionOrder: number[] = [];

      const results = await step.parallel("branches", [
        async () => {
          executionOrder.push(1);
          return "a";
        },
        async () => {
          executionOrder.push(2);
          return "b";
        },
        async () => {
          executionOrder.push(3);
          return "c";
        },
      ]);

      expect(results).toEqual(["a", "b", "c"]);
      expect(executionOrder).toHaveLength(3);
    });

    it("should throw first error and stop execution", async () => {
      const completed: string[] = [];

      await expect(
        step.parallel("failingBranches", [
          async () => {
            completed.push("a");
            return "a";
          },
          async () => {
            throw new Error("Branch 2 failed");
          },
          async () => {
            // This may or may not complete depending on timing
            await new Promise((r) => setTimeout(r, 50));
            completed.push("c");
            return "c";
          },
        ])
      ).rejects.toThrow("Branch 2 failed");
    });

    it("should re-throw YieldSignal from any branch", async () => {
      try {
        await step.parallel("yieldingBranches", [
          async () => "a",
          async (branchStep) => {
            await branchStep.sleep("sleep", "1h");
            return "b";
          },
          async () => "c",
        ]);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(isYieldSignal(error)).toBe(true);
      }
    });
  });

  describe("allSettled mode", () => {
    it("should execute all branches even when some fail", async () => {
      const results = await step.parallel(
        "mixedBranches",
        [
          async () => "success1",
          async () => {
            throw new Error("Failed");
          },
          async () => "success2",
        ],
        { onError: "allSettled" }
      );

      expect(results[0]).toBe("success1");
      expect(results[1]).toBeInstanceOf(Error);
      expect((results[1] as Error).message).toBe("Failed");
      expect(results[2]).toBe("success2");
    });

    it("should not throw when all branches fail", async () => {
      const results = await step.parallel(
        "allFailing",
        [
          async () => {
            throw new Error("Error 1");
          },
          async () => {
            throw new Error("Error 2");
          },
        ],
        { onError: "allSettled" }
      );

      expect(results[0]).toBeInstanceOf(Error);
      expect(results[1]).toBeInstanceOf(Error);
    });

    it("should still throw YieldSignal in allSettled mode", async () => {
      try {
        await step.parallel(
          "yieldingAllSettled",
          [
            async () => "a",
            async (branchStep) => {
              await branchStep.sleep("sleep", "1h");
              return "b";
            },
          ],
          { onError: "allSettled" }
        );
        expect.fail("Should have thrown");
      } catch (error) {
        expect(isYieldSignal(error)).toBe(true);
      }
    });
  });

  describe("concurrency limit", () => {
    it("should respect concurrency limit", async () => {
      const activeTasks = { current: 0, max: 0 };

      await step.parallel(
        "limitedConcurrency",
        [
          async () => {
            activeTasks.current++;
            activeTasks.max = Math.max(activeTasks.max, activeTasks.current);
            await new Promise((r) => setTimeout(r, 10));
            activeTasks.current--;
            return 1;
          },
          async () => {
            activeTasks.current++;
            activeTasks.max = Math.max(activeTasks.max, activeTasks.current);
            await new Promise((r) => setTimeout(r, 10));
            activeTasks.current--;
            return 2;
          },
          async () => {
            activeTasks.current++;
            activeTasks.max = Math.max(activeTasks.max, activeTasks.current);
            await new Promise((r) => setTimeout(r, 10));
            activeTasks.current--;
            return 3;
          },
          async () => {
            activeTasks.current++;
            activeTasks.max = Math.max(activeTasks.max, activeTasks.current);
            await new Promise((r) => setTimeout(r, 10));
            activeTasks.current--;
            return 4;
          },
        ],
        { concurrency: 2 }
      );

      expect(activeTasks.max).toBeLessThanOrEqual(2);
    });

    it("should process all items even with concurrency limit", async () => {
      const results = await step.parallel(
        "allProcessed",
        [async () => 1, async () => 2, async () => 3, async () => 4, async () => 5],
        { concurrency: 2 }
      );

      expect(results).toEqual([1, 2, 3, 4, 5]);
    });

    it("should stop launching branches after error in failFast mode with concurrency limit", async () => {
      const started: number[] = [];

      await expect(
        step.parallel(
          "failFastConcurrency",
          [
            async () => {
              started.push(0);
              await new Promise((r) => setTimeout(r, 50));
              return "a";
            },
            async () => {
              started.push(1);
              throw new Error("Branch 1 failed");
            },
            async () => {
              started.push(2);
              return "c";
            },
            async () => {
              started.push(3);
              return "d";
            },
            async () => {
              started.push(4);
              return "e";
            },
          ],
          { concurrency: 2, onError: "failFast" }
        )
      ).rejects.toThrow("Branch 1 failed");

      // With concurrency=2, branches 0 and 1 start. Branch 1 fails,
      // setting cancelled=true. The loop checks cancelled before
      // launching new branches, so branches 3-4 are never started.
      // Branch 2's executeBranch is called but bails at the cancelled check.
      expect(started).toContain(0);
      expect(started).toContain(1);
      expect(started).not.toContain(2);
      expect(started).not.toContain(3);
      expect(started).not.toContain(4);
    });

    it("should execute all branches with concurrency limit in allSettled mode", async () => {
      const started: number[] = [];

      const results = await step.parallel(
        "allSettledConcurrency",
        [
          async () => {
            started.push(0);
            await new Promise((r) => setTimeout(r, 10));
            return "a";
          },
          async () => {
            started.push(1);
            throw new Error("Branch 1 failed");
          },
          async () => {
            started.push(2);
            return "c";
          },
          async () => {
            started.push(3);
            return "d";
          },
        ],
        { concurrency: 2, onError: "allSettled" }
      );

      // All branches should execute in allSettled mode
      expect(started).toEqual(expect.arrayContaining([0, 1, 2, 3]));
      expect(results[0]).toBe("a");
      expect(results[1]).toBeInstanceOf(Error);
      expect((results[1] as Error).message).toBe("Branch 1 failed");
      expect(results[2]).toBe("c");
      expect(results[3]).toBe("d");
    });
  });

  describe("nested steps in branches", () => {
    it("should scope step IDs to each branch", async () => {
      await step.parallel("nestedSteps", [
        async (branchStep) => {
          return branchStep.run("innerStep", async () => "from branch 0");
        },
        async (branchStep) => {
          return branchStep.run("innerStep", async () => "from branch 1");
        },
      ]);

      expect(ctx.executedSteps).toHaveLength(2);
      expect(ctx.executedSteps[0]!.id).toContain("nestedSteps:0:innerStep");
      expect(ctx.executedSteps[1]!.id).toContain("nestedSteps:1:innerStep");
      expect(ctx.executedSteps[0]!.id).not.toBe(ctx.executedSteps[1]!.id);
    });

    it("should support deeply nested parallel execution", async () => {
      const results = await step.parallel("outer", [
        async (outerStep) => {
          return outerStep.parallel("inner", [
            async (innerStep) => innerStep.run("deep", async () => "deep-0-0"),
            async (innerStep) => innerStep.run("deep", async () => "deep-0-1"),
          ]);
        },
        async (outerStep) => {
          return outerStep.parallel("inner", [
            async (innerStep) => innerStep.run("deep", async () => "deep-1-0"),
          ]);
        },
      ]);

      expect(results).toEqual([["deep-0-0", "deep-0-1"], ["deep-1-0"]]);
      expect(ctx.executedSteps).toHaveLength(3);
    });
  });
});

describe("map", () => {
  let ctx: MockStepContext;
  let step: StepClient;

  beforeEach(() => {
    ctx = createMockContext();
    step = createStepClient(ctx);
  });

  it("should map over items with step client", async () => {
    const items = [1, 2, 3];

    const results = await step.map("processItems", items, async (item, itemStep, index) => {
      return itemStep.run(`process-${index}`, async () => item * 2);
    });

    expect(results).toEqual([2, 4, 6]);
    expect(ctx.executedSteps).toHaveLength(3);
  });

  it("should respect concurrency in map", async () => {
    const activeTasks = { current: 0, max: 0 };
    const items = [1, 2, 3, 4];

    await step.map(
      "limitedMap",
      items,
      async (item) => {
        activeTasks.current++;
        activeTasks.max = Math.max(activeTasks.max, activeTasks.current);
        await new Promise((r) => setTimeout(r, 10));
        activeTasks.current--;
        return item * 2;
      },
      { concurrency: 2 }
    );

    expect(activeTasks.max).toBeLessThanOrEqual(2);
  });

  it("should use allSettled mode in map", async () => {
    const items = [1, 2, 3];

    const results = await step.map(
      "mixedMap",
      items,
      async (item) => {
        if (item === 2) throw new Error("Item 2 failed");
        return item * 2;
      },
      { onError: "allSettled" }
    );

    expect(results[0]).toBe(2);
    expect(results[1]).toBeInstanceOf(Error);
    expect(results[2]).toBe(6);
  });

  it("should throw on error in failFast mode (default)", async () => {
    const items = [1, 2, 3];

    await expect(
      step.map("failFastMap", items, async (item) => {
        if (item === 2) throw new Error("Item 2 failed");
        return item * 2;
      })
    ).rejects.toThrow("Item 2 failed");
  });

  it("should stop processing items after error in failFast mode with concurrency limit", async () => {
    const processed: number[] = [];
    const items = [1, 2, 3, 4, 5];

    await expect(
      step.map(
        "failFastConcurrencyMap",
        items,
        async (item) => {
          if (item === 2) throw new Error("Item 2 failed");
          processed.push(item);
          await new Promise((r) => setTimeout(r, 50));
          return item * 2;
        },
        { concurrency: 2, onError: "failFast" }
      )
    ).rejects.toThrow("Item 2 failed");

    // With concurrency=2, items 1 and 2 start. Item 2 fails,
    // remaining items should not be processed.
    expect(processed).toContain(1);
    expect(processed).not.toContain(3);
    expect(processed).not.toContain(4);
    expect(processed).not.toContain(5);
  });

  it("should handle allSettled mode with concurrency limit and errors", async () => {
    const items = [1, 2, 3, 4, 5];

    const results = await step.map(
      "allSettledConcurrencyMap",
      items,
      async (item) => {
        if (item === 2 || item === 4) throw new Error(`Item ${item} failed`);
        await new Promise((r) => setTimeout(r, 10));
        return item * 2;
      },
      { concurrency: 2, onError: "allSettled" }
    );

    // All items should be processed in allSettled mode
    expect(results[0]).toBe(2);
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as unknown as Error).message).toBe("Item 2 failed");
    expect(results[2]).toBe(6);
    expect(results[3]).toBeInstanceOf(Error);
    expect((results[3] as unknown as Error).message).toBe("Item 4 failed");
    expect(results[4]).toBe(10);
  });
});

// ============================================================================
// Tests for real createStepClient (imported from step.ts)
// ============================================================================

import { createStepClient as createRealStepClient } from "./step.js";
import { ExecutionContext } from "./internal/context.js";
import {
  YieldSignal as RealYieldSignal,
  isYieldSignal as realIsYieldSignal,
} from "./internal/errors.js";
import { StepError } from "@ironflow/core";
import type { PushRequest } from "@ironflow/core";

function createTestContext(overrides?: Partial<PushRequest>, options?: { serverUrl?: string; apiKey?: string }): ExecutionContext {
  const request: PushRequest = {
    run_id: "run_test_123",
    function_id: "test-fn",
    attempt: 1,
    event: {
      id: "evt_1",
      name: "test.event",
      data: { key: "value" },
      timestamp: new Date().toISOString(),
      version: 1,
    },
    steps: [],
    ...overrides,
  };
  return new ExecutionContext(request, undefined, undefined, undefined, options?.serverUrl, options?.apiKey);
}

describe("createStepClient (real implementation)", () => {
  describe("step.run", () => {
    it("should execute and return result", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      const result = await step.run("fetch-data", async () => {
        return { users: ["alice", "bob"] };
      });

      expect(result).toEqual({ users: ["alice", "bob"] });

      const executed = ctx.getExecutedSteps();
      expect(executed).toHaveLength(1);
      expect(executed[0]!.status).toBe("completed");
      expect(executed[0]!.name).toBe("fetch-data");
      expect(executed[0]!.output).toEqual({ users: ["alice", "bob"] });
    });

    it("should memoize a completed step", async () => {
      const ctx = createTestContext({
        steps: [
          {
            id: "run_test_123:cached-step:0",
            name: "cached-step",
            status: "completed",
            output: "memoized-value",
          },
        ],
      });
      const step = createRealStepClient(ctx);

      let functionCalled = false;
      const result = await step.run("cached-step", async () => {
        functionCalled = true;
        return "fresh-value";
      });

      expect(result).toBe("memoized-value");
      expect(functionCalled).toBe(false);
      expect(ctx.getExecutedSteps()).toHaveLength(0);
    });

    it("should wrap errors in StepError", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      try {
        await step.run("failing-step", async () => {
          throw new Error("something broke");
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StepError);
        const stepErr = error as StepError;
        expect(stepErr.stepName).toBe("failing-step");
        expect(stepErr.message).toBe("something broke");
      }

      const executed = ctx.getExecutedSteps();
      expect(executed).toHaveLength(1);
      expect(executed[0]!.status).toBe("failed");
      expect(executed[0]!.error?.message).toBe("something broke");
    });
  });

  describe("step.sleep", () => {
    it("should yield with YieldSignal of type sleep", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      try {
        await step.sleep("wait-a-bit", "1h");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(realIsYieldSignal(error)).toBe(true);
        const signal = error as RealYieldSignal;
        expect(signal.yieldInfo.type).toBe("sleep");
        expect(signal.yieldInfo.step_id).toBe("run_test_123:wait-a-bit:0");
      }
    });
  });

  describe("step.waitForEvent", () => {
    it("should yield with YieldSignal of type wait_for_event", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      try {
        await step.waitForEvent("wait-approval", {
          event: "order.approved",
          match: "data.orderId == '999'",
          timeout: "12h",
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(realIsYieldSignal(error)).toBe(true);
        const signal = error as RealYieldSignal;
        expect(signal.yieldInfo.type).toBe("wait_for_event");
        if (signal.yieldInfo.type === "wait_for_event") {
          expect(signal.yieldInfo.event_filter.event).toBe("order.approved");
          expect(signal.yieldInfo.event_filter.match).toBe(
            "data.orderId == '999'"
          );
          expect(signal.yieldInfo.event_filter.timeout).toBe("12h");
        }
      }
    });
  });

  describe("step.sleepUntil", () => {
    it("should throw on invalid date string", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      await expect(
        step.sleepUntil("bad-date", "not-a-valid-date")
      ).rejects.toThrow("Invalid date for sleepUntil");
    });
  });

  describe("step.publish", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("should publish via HTTP and record a step", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_abc",
            sequence: "7",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const ctx = createTestContext(undefined, {
        serverUrl: "http://localhost:9123",
      });
      const step = createRealStepClient(ctx);

      const result = await step.publish("order.processed", {
        orderId: "123",
      });

      expect(result.eventId).toBe("msg_abc");
      expect(result.sequence).toBe(7);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.PubSubService/Publish",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.topic).toBe("order.processed");
      expect(body.data).toEqual({ orderId: "123" });

      // Verify step was recorded
      const executed = ctx.getExecutedSteps();
      expect(executed).toHaveLength(1);
      expect(executed[0]!.name).toBe("publish:order.processed");
      expect(executed[0]!.status).toBe("completed");
    });

    it("should throw StepError when serverUrl is not configured", async () => {
      const ctx = createTestContext();
      const step = createRealStepClient(ctx);

      try {
        await step.publish("test-topic", { data: 1 });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StepError);
        expect((error as StepError).message).toContain(
          "Server URL not configured"
        );
      }
    });

    it("should memoize a completed publish step", async () => {
      const ctx = createTestContext(
        {
          steps: [
            {
              id: "run_test_123:publish:notifications:0",
              name: "publish:notifications",
              status: "completed",
              output: { eventId: "msg_cached", sequence: 5 },
            },
          ],
        },
        { serverUrl: "http://localhost:9123" }
      );
      const step = createRealStepClient(ctx);

      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const result = await step.publish("notifications", { msg: "hi" });

      expect(result).toEqual({ eventId: "msg_cached", sequence: 5 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should include Authorization header when apiKey is set", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_auth",
            sequence: "1",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const ctx = createTestContext(undefined, {
        serverUrl: "http://localhost:9123",
        apiKey: "my-secret-key",
      });
      const step = createRealStepClient(ctx);

      await step.publish("secure-topic", { x: 1 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.PubSubService/Publish",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer my-secret-key",
          },
        })
      );
    });
  });
});
