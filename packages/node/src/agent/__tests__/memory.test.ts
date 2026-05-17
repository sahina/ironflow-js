import { describe, expect, it, vi } from "vitest";
import { IronflowError } from "@ironflow/core";
import type {
  AppendResult,
  StepClient,
  StepRunOptions,
} from "@ironflow/core";
import { MemoryProjectionRequiredError } from "../errors.js";
import {
  type MemoryBackend,
  createMemoryRuntimeCache,
  createMemoryRuntimeCounters,
  makeMemory,
} from "../memory.js";

function makeFakeStep(): {
  step: StepClient;
  runCalls: Array<{ name: string }>;
} {
  const runCalls: Array<{ name: string }> = [];
  const step = {
    async run<T>(
      name: string,
      fn: () => Promise<T>,
      _options?: StepRunOptions
    ): Promise<T> {
      runCalls.push({ name });
      return fn();
    },
  } as unknown as StepClient;
  return { step, runCalls };
}

function makeFakeBackend(overrides: Partial<MemoryBackend> = {}): {
  backend: MemoryBackend;
  appendCalls: Array<{ streamId: string; input: Parameters<MemoryBackend["appendEvent"]>[1] }>;
  getCalls: string[];
  waitCalls: Array<{ name: string; opts: Parameters<MemoryBackend["waitForCatchup"]>[1] }>;
} {
  const appendCalls: Array<{ streamId: string; input: Parameters<MemoryBackend["appendEvent"]>[1] }> = [];
  const getCalls: string[] = [];
  const waitCalls: Array<{ name: string; opts: Parameters<MemoryBackend["waitForCatchup"]>[1] }> = [];

  const backend: MemoryBackend = {
    appendEvent: vi.fn(async (streamId, input): Promise<AppendResult> => {
      appendCalls.push({ streamId, input });
      return { entityVersion: 1, eventId: "evt-1", sequence: 42 };
    }),
    getProjection: vi.fn(async (name: string) => {
      getCalls.push(name);
      return {
        name,
        partition: "__global__",
        state: { count: 7 },
        lastEventId: "evt-1",
        lastEventSeq: 1,
        lastEventTime: new Date("2026-04-26T00:00:00Z"),
        version: 1,
        mode: "managed",
        updatedAt: new Date("2026-04-26T00:00:00Z"),
      };
    }) as unknown as MemoryBackend["getProjection"],
    waitForCatchup: vi.fn(async (name, opts) => {
      waitCalls.push({ name, opts });
    }),
    ...overrides,
  };
  return { backend, appendCalls, getCalls, waitCalls };
}

describe("makeMemory() — guard rails", () => {
  it("throws AGENT_MEMORY_UNCONFIGURED when AgentConfig.memory is unset", async () => {
    const { step } = makeFakeStep();
    const memory = makeMemory(step, undefined, "run-1", createMemoryRuntimeCache(), undefined);

    await expect(memory.get()).rejects.toBeInstanceOf(IronflowError);
    await expect(memory.get()).rejects.toMatchObject({ code: "AGENT_MEMORY_UNCONFIGURED" });
    await expect(memory.append("evt", {})).rejects.toMatchObject({
      code: "AGENT_MEMORY_UNCONFIGURED",
    });
  });

  it("throws AGENT_MEMORY_NO_BACKEND when configured but no backend supplied", async () => {
    const { step } = makeFakeStep();
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-1", projection: "agent-memory" },
      "run-1",
      createMemoryRuntimeCache(),
      undefined
    );

    await expect(memory.get()).rejects.toMatchObject({ code: "AGENT_MEMORY_NO_BACKEND" });
    await expect(memory.append("evt", {})).rejects.toMatchObject({
      code: "AGENT_MEMORY_NO_BACKEND",
    });
  });

  it("entityStream() throws MemoryProjectionRequiredError on empty projection name", async () => {
    const { step } = makeFakeStep();
    const memory = makeMemory(step, undefined, "run-1", createMemoryRuntimeCache(), undefined);

    await expect(memory.entityStream("stream-1", "")).rejects.toBeInstanceOf(
      MemoryProjectionRequiredError
    );
  });

  it("entityStream() with projection still throws NotImplementedError (deferred)", async () => {
    const { step } = makeFakeStep();
    const { backend } = makeFakeBackend();
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-1", projection: "agent-memory" },
      "run-1",
      createMemoryRuntimeCache(),
      backend
    );

    await expect(memory.entityStream("stream-1", "some-projection")).rejects.toMatchObject({
      code: "AGENT_MEMORY_NOT_IMPLEMENTED",
    });
  });
});

describe("makeMemory() — append()", () => {
  it("calls backend.appendEvent and waitForCatchup, invalidates cache", async () => {
    const { step, runCalls } = makeFakeStep();
    const { backend, appendCalls, waitCalls } = makeFakeBackend();
    const cache = createMemoryRuntimeCache();
    cache.has = true;
    cache.value = { stale: true };

    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      cache,
      backend
    );

    await memory.append("noted", { fact: "hello" }, { metadata: { src: "test" } });

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.streamId).toBe("agent-mem-run-1");
    expect(appendCalls[0]!.input).toMatchObject({
      name: "noted",
      data: { fact: "hello" },
      entityType: "agent",
      metadata: { src: "test" },
    });

    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]!.name).toBe("agent-memory");
    expect(waitCalls[0]!.opts).toMatchObject({ minSeq: 42 });
    expect(waitCalls[0]!.opts.partition).toBeUndefined();

    expect(cache.has).toBe(false);
    expect(cache.value).toBeUndefined();
    expect(runCalls.map((r) => r.name)).toEqual(["memory.append", "memory.append.wait"]);
  });

  it("idempotency key shape includes runId + counter, increments per call", async () => {
    const { step } = makeFakeStep();
    const { backend, appendCalls } = makeFakeBackend();
    const counters = createMemoryRuntimeCounters();
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-9", projection: "agent-memory" },
      "run-9",
      createMemoryRuntimeCache(),
      backend,
      counters
    );

    await memory.append("a", { i: 0 });
    await memory.append("b", { i: 1 });
    await memory.append("c", { i: 2 });

    expect(appendCalls.map((c) => c.input.idempotencyKey)).toEqual([
      "run-9:memory.append:0",
      "run-9:memory.append:1",
      "run-9:memory.append:2",
    ]);
  });

  it("skips waitForCatchup when sequence is 0 or undefined", async () => {
    const { step, runCalls } = makeFakeStep();
    const { backend, waitCalls } = makeFakeBackend({
      appendEvent: vi.fn(async () => ({ entityVersion: 1, eventId: "e", sequence: 0 })),
    });
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      createMemoryRuntimeCache(),
      backend
    );

    await memory.append("evt", { a: 1 });

    expect(waitCalls).toHaveLength(0);
    expect(runCalls.map((r) => r.name)).toEqual(["memory.append"]);
  });

  it("rejects non-object data with AGENT_MEMORY_INVALID_DATA", async () => {
    const { step } = makeFakeStep();
    const { backend, appendCalls } = makeFakeBackend();
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      createMemoryRuntimeCache(),
      backend
    );

    await expect(memory.append("count", 42)).rejects.toMatchObject({
      code: "AGENT_MEMORY_INVALID_DATA",
    });
    await expect(memory.append("list", [1, 2, 3])).rejects.toMatchObject({
      code: "AGENT_MEMORY_INVALID_DATA",
    });
    await expect(memory.append("nullish", null)).rejects.toMatchObject({
      code: "AGENT_MEMORY_INVALID_DATA",
    });
    expect(appendCalls).toHaveLength(0);
  });

  it("uses MemoryConfig.entityType when provided, else defaults to 'agent'", async () => {
    const { step } = makeFakeStep();
    const { backend, appendCalls } = makeFakeBackend();

    const explicit = makeMemory(
      step,
      { streamId: "review-99", projection: "p", entityType: "code-review" },
      "run-x",
      createMemoryRuntimeCache(),
      backend
    );
    await explicit.append("noted", { fact: 1 });
    expect(appendCalls.at(-1)!.input.entityType).toBe("code-review");

    const defaulted = makeMemory(
      step,
      { streamId: "weird_id_no_dash", projection: "p" },
      "run-y",
      createMemoryRuntimeCache(),
      backend
    );
    await defaulted.append("noted", { fact: 2 });
    expect(appendCalls.at(-1)!.input.entityType).toBe("agent");
  });
});

describe("makeMemory() — get()", () => {
  it("returns projection.state on cold cache and populates cache", async () => {
    const { step, runCalls } = makeFakeStep();
    const { backend, getCalls } = makeFakeBackend();
    const cache = createMemoryRuntimeCache();
    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      cache,
      backend
    );

    const result = await memory.get<{ count: number }>();

    expect(result).toEqual({ count: 7 });
    expect(getCalls).toEqual(["agent-memory"]);
    expect(cache.has).toBe(true);
    expect(cache.value).toEqual({ count: 7 });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.name).toBe("memory.get");
  });

  it("returns cached value on warm cache without calling backend", async () => {
    const { step, runCalls } = makeFakeStep();
    const { backend, getCalls } = makeFakeBackend();
    const cache = createMemoryRuntimeCache();
    cache.has = true;
    cache.value = { cached: true };

    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      cache,
      backend
    );

    const result = await memory.get();

    expect(result).toEqual({ cached: true });
    expect(getCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("bypasses cache when bypassCache=true", async () => {
    const { step } = makeFakeStep();
    const { backend, getCalls } = makeFakeBackend();
    const cache = createMemoryRuntimeCache();
    cache.has = true;
    cache.value = { stale: true };

    const memory = makeMemory(
      step,
      { streamId: "agent-mem-run-1", projection: "agent-memory" },
      "run-1",
      cache,
      backend
    );

    const result = await memory.get<{ count: number }>({ bypassCache: true });

    expect(result).toEqual({ count: 7 });
    expect(getCalls).toEqual(["agent-memory"]);
  });
});
