import { describe, expect, it } from "vitest";
import type { StepClient } from "@ironflow/core";
import {
  LLMMaxTokensError,
  LLMRefusalError,
  MaxTurnsExceededError,
} from "../errors.js";
import { createTurnCounter, makeLlm } from "../llm.js";
import type { LLMCompleteResult } from "../types.js";

function makeFakeStep(): StepClient {
  return {
    async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  } as unknown as StepClient;
}

describe("makeLlm() — turn counter", () => {
  it("increments the counter on each complete() call", async () => {
    const counter = createTurnCounter();
    const llm = makeLlm(makeFakeStep(), counter, 5);

    expect(counter.value).toBe(0);
    await llm.complete({
      messages: [],
      call: async (): Promise<LLMCompleteResult> => ({ content: "1" }),
    });
    expect(counter.value).toBe(1);
    await llm.complete({
      messages: [],
      call: async (): Promise<LLMCompleteResult> => ({ content: "2" }),
    });
    expect(counter.value).toBe(2);
  });

  it("throws MaxTurnsExceededError when budget is exhausted", async () => {
    const counter = createTurnCounter();
    const llm = makeLlm(makeFakeStep(), counter, 1);

    await llm.complete({
      messages: [],
      call: async (): Promise<LLMCompleteResult> => ({ content: "first" }),
    });
    await expect(
      llm.complete({
        messages: [],
        call: async (): Promise<LLMCompleteResult> => ({ content: "second" }),
      })
    ).rejects.toBeInstanceOf(MaxTurnsExceededError);
  });
});

describe("makeLlm() — error classification", () => {
  it("classifies finishReason='refusal' as LLMRefusalError", async () => {
    const llm = makeLlm(makeFakeStep(), createTurnCounter(), 10);
    await expect(
      llm.complete({
        messages: [],
        call: async (): Promise<LLMCompleteResult> => ({
          content: null,
          finishReason: "refusal",
        }),
      })
    ).rejects.toBeInstanceOf(LLMRefusalError);
  });

  it("classifies finishReason='content_filter' as LLMRefusalError", async () => {
    const llm = makeLlm(makeFakeStep(), createTurnCounter(), 10);
    await expect(
      llm.complete({
        messages: [],
        call: async (): Promise<LLMCompleteResult> => ({
          finishReason: "content_filter",
        }),
      })
    ).rejects.toBeInstanceOf(LLMRefusalError);
  });

  it("classifies finishReason='max_tokens' as LLMMaxTokensError", async () => {
    const llm = makeLlm(makeFakeStep(), createTurnCounter(), 10);
    await expect(
      llm.complete({
        messages: [],
        call: async (): Promise<LLMCompleteResult> => ({
          content: "truncated...",
          finishReason: "max_tokens",
        }),
      })
    ).rejects.toBeInstanceOf(LLMMaxTokensError);
  });

  it("classifies finishReason='length' as LLMMaxTokensError", async () => {
    const llm = makeLlm(makeFakeStep(), createTurnCounter(), 10);
    await expect(
      llm.complete({
        messages: [],
        call: async (): Promise<LLMCompleteResult> => ({
          finishReason: "length",
        }),
      })
    ).rejects.toBeInstanceOf(LLMMaxTokensError);
  });

  it("passes through results with no finishReason or unrecognized values", async () => {
    const llm = makeLlm(makeFakeStep(), createTurnCounter(), 10);

    const noReason = await llm.complete({
      messages: [],
      call: async (): Promise<LLMCompleteResult> => ({ content: "ok" }),
    });
    expect(noReason.content).toBe("ok");

    const unknownReason = await llm.complete({
      messages: [],
      call: async (): Promise<LLMCompleteResult> => ({
        content: "done",
        finishReason: "stop",
      }),
    });
    expect(unknownReason.content).toBe("done");
  });
});
