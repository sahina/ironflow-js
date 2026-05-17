import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestClient } from "../../test/index.js";
import { agent } from "../agent.js";
import { DuplicateToolError, MaxTurnsExceededError } from "../errors.js";
import { defineTool } from "../tool.js";
import type { LLMCompleteResult } from "../types.js";

describe("agent()", () => {
  it("returns an IronflowFunction registerable via createTestClient", async () => {
    const myAgent = agent(
      {
        id: "noop-agent",
        triggers: [{ event: "noop.start" }],
        schema: z.object({ greeting: z.string() }),
      },
      async ({ event }) => ({ echoed: event.data.greeting })
    );

    const client = createTestClient({ functions: [myAgent] });
    const run = await client.emit("noop.start", { greeting: "hi" });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ echoed: "hi" });
  });

  it("exposes a turn counter that increments per llm() call", async () => {
    let observedTurns = 0;

    const myAgent = agent(
      {
        id: "turn-agent",
        triggers: [{ event: "turn.start" }],
      },
      async (ctx) => {
        expect(ctx.turn).toBe(0);
        await ctx.llm.complete({
          messages: [],
          call: async (): Promise<LLMCompleteResult> => ({ content: "ok" }),
        });
        observedTurns = ctx.turn;
        return { observedTurns };
      }
    );

    const client = createTestClient({ functions: [myAgent] });
    client.mockStep("llm.turn", () => ({ content: "ok" }));
    const run = await client.emit("turn.start", {});

    expect(run.status).toBe("completed");
    expect(observedTurns).toBe(1);
  });

  it("trips MaxTurnsExceededError when llm() exceeds the budget", async () => {
    const myAgent = agent(
      {
        id: "budget-agent",
        triggers: [{ event: "budget.start" }],
        maxTurns: 2,
      },
      async ({ llm }) => {
        await llm.complete({
          messages: [],
          call: async (): Promise<LLMCompleteResult> => ({ content: "1" }),
        });
        await llm.complete({
          messages: [],
          call: async (): Promise<LLMCompleteResult> => ({ content: "2" }),
        });
        await llm.complete({
          messages: [],
          call: async (): Promise<LLMCompleteResult> => ({ content: "3" }),
        });
        return "should not reach";
      }
    );

    const client = createTestClient({ functions: [myAgent] });
    client.mockStep("llm.turn", () => ({ content: "ok" }));
    const run = await client.emit("budget.start", {});

    expect(run.status).toBe("failed");
    expect(run.error).toBeInstanceOf(MaxTurnsExceededError);
    expect((run.error as MaxTurnsExceededError).code).toBe("AGENT_MAX_TURNS_EXCEEDED");
  });

  it("throws DuplicateToolError when AgentConfig.tools contains duplicate names", () => {
    const a = defineTool({
      name: "duplicate",
      input: z.object({}),
      handler: async () => "a",
    });
    const b = defineTool({
      name: "duplicate",
      input: z.object({}),
      handler: async () => "b",
    });

    expect(() =>
      agent(
        { id: "dup", triggers: [{ event: "dup.start" }], tools: [a, b] },
        async () => "noop"
      )
    ).toThrowError(DuplicateToolError);
  });

  it("uses default maxTurns of 20 when not configured", async () => {
    const myAgent = agent(
      {
        id: "default-budget-agent",
        triggers: [{ event: "default-budget.start" }],
      },
      async ({ llm }) => {
        for (let i = 0; i < 21; i += 1) {
          await llm.complete({
            messages: [],
            call: async (): Promise<LLMCompleteResult> => ({ content: String(i) }),
          });
        }
        return "should not reach";
      }
    );

    const client = createTestClient({ functions: [myAgent] });
    client.mockStep("llm.turn", () => ({ content: "ok" }));
    const run = await client.emit("default-budget.start", {});

    expect(run.status).toBe("failed");
    expect(run.error).toBeInstanceOf(MaxTurnsExceededError);
    expect((run.error as MaxTurnsExceededError).details).toEqual({ maxTurns: 20 });
  });
});
