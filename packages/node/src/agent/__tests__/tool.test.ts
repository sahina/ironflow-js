import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepClient, StepRunOptions } from "@ironflow/core";
import { ToolNotFoundError, ToolValidationError } from "../errors.js";
import {
  createToolRuntime,
  defineTool,
  makeTool,
} from "../tool.js";
import type { ToolDefinition } from "../types.js";

function makeFakeStep(): {
  step: StepClient;
  runCalls: Array<{ name: string; options?: StepRunOptions }>;
} {
  const runCalls: Array<{ name: string; options?: StepRunOptions }> = [];
  const step = {
    async run<T>(
      name: string,
      fn: () => Promise<T>,
      options?: StepRunOptions
    ): Promise<T> {
      runCalls.push({ name, options });
      return fn();
    },
  } as unknown as StepClient;
  return { step, runCalls };
}

describe("defineTool()", () => {
  it("returns the spec unchanged (factory is a pass-through)", () => {
    const spec: ToolDefinition<{ x: number }, number> = {
      name: "double",
      input: z.object({ x: z.number() }),
      handler: async ({ x }) => x * 2,
    };
    expect(defineTool(spec)).toBe(spec);
  });
});

describe("makeTool() — input validation", () => {
  it("throws ToolValidationError with issues when args fail Zod", async () => {
    const def = defineTool({
      name: "echo",
      input: z.object({ x: z.number() }),
      handler: async ({ x }) => x,
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await expect(tool(def, { x: "not-a-number" } as never)).rejects.toBeInstanceOf(
      ToolValidationError
    );
    expect(runCalls).toHaveLength(0);
  });

  it("passes validated input to the handler on success", async () => {
    const handler = vi.fn(async ({ x }: { x: number }) => x * 2);
    const def = defineTool({
      name: "double",
      input: z.object({ x: z.number() }),
      handler,
    });
    const { step } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    const result = await tool(def, { x: 21 });
    expect(result).toBe(42);
    expect(handler).toHaveBeenCalledWith({ x: 21 });
  });
});

describe("makeTool() — name lookup vs reference", () => {
  it("resolves a registered tool by string name", async () => {
    const def = defineTool({
      name: "lookup-me",
      input: z.object({ x: z.number() }),
      handler: async ({ x }) => x + 1,
    });
    const { step } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    const result = await tool("lookup-me", { x: 1 });
    expect(result).toBe(2);
  });

  it("throws ToolNotFoundError for an unregistered name", async () => {
    const { step } = makeFakeStep();
    const tool = makeTool(step, new Map(), createToolRuntime());

    await expect(tool("missing", {})).rejects.toBeInstanceOf(ToolNotFoundError);
  });
});

describe("makeTool() — idempotency", () => {
  it("byCall: each call is a separate step.run invocation", async () => {
    const def = defineTool({
      name: "ping",
      input: z.object({ id: z.string() }),
      idempotent: "byCall",
      handler: async ({ id }) => id,
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, { id: "a" });
    await tool(def, { id: "a" }); // identical args, byCall = separate steps

    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]!.name).toBe("tool.ping");
    expect(runCalls[1]!.name).toBe("tool.ping");
  });

  it("byArgs: same args dedupe to a single step.run with hashed name", async () => {
    const handler = vi.fn(async ({ id }: { id: string }) => id);
    const def = defineTool({
      name: "fetch",
      input: z.object({ id: z.string() }),
      idempotent: "byArgs",
      handler,
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    const a = await tool(def, { id: "x" });
    const b = await tool(def, { id: "x" });
    const c = await tool(def, { id: "y" });

    expect(a).toBe("x");
    expect(b).toBe("x");
    expect(c).toBe("y");
    expect(handler).toHaveBeenCalledTimes(2); // x once, y once
    expect(runCalls).toHaveLength(2);
    expect(runCalls.every((r) => r.name.startsWith("tool.fetch."))).toBe(true);
  });

  it("byArgs: hashes Date instances by ISO string (toJSON), no false dedupe", async () => {
    const handler = vi.fn(async (args: { at: Date }) => args.at.toISOString());
    const def = defineTool({
      name: "by-date",
      input: z.object({ at: z.date() }),
      idempotent: "byArgs",
      handler,
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, { at: new Date("2026-01-01T00:00:00Z") });
    await tool(def, { at: new Date("2026-01-01T00:00:00Z") }); // dedupes (same instant)
    await tool(def, { at: new Date("2026-06-01T00:00:00Z") }); // different

    expect(handler).toHaveBeenCalledTimes(2);
    expect(runCalls).toHaveLength(2);
  });

  it("byArgs: stable hash regardless of key order in args", async () => {
    const handler = vi.fn(async (args: { a: number; b: number }) => args.a + args.b);
    const def = defineTool({
      name: "sum",
      input: z.object({ a: z.number(), b: z.number() }),
      idempotent: "byArgs",
      handler,
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, { a: 1, b: 2 });
    await tool(def, { b: 2, a: 1 } as { a: number; b: number });

    expect(runCalls).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("makeTool() — timeout", () => {
  it("passes the configured timeout into step.run options", async () => {
    const def = defineTool({
      name: "slow",
      input: z.object({}),
      timeout: "30s",
      handler: async () => "done",
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, {});

    expect(runCalls[0]!.options?.timeout).toBe("30s");
  });

  it("defaults timeout to 60s when not specified", async () => {
    const def = defineTool({
      name: "default-timeout",
      input: z.object({}),
      handler: async () => "done",
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, {});

    expect(runCalls[0]!.options?.timeout).toBe("60s");
  });

  it("normalizes numeric duration to ms-suffixed string", async () => {
    const def = defineTool({
      name: "numeric-timeout",
      input: z.object({}),
      timeout: 5000,
      handler: async () => "done",
    });
    const { step, runCalls } = makeFakeStep();
    const tool = makeTool(step, new Map([[def.name, def]]), createToolRuntime());

    await tool(def, {});

    expect(runCalls[0]!.options?.timeout).toBe("5000ms");
  });
});
