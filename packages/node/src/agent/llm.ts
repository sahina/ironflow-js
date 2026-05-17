/**
 * llm() — memoized completion sugar with classified error surface.
 *
 * The wrapper does not own a provider router. Callers pass a closure
 * (request.call) that talks to their provider of choice and returns a
 * normalized LLMCompleteResult. The wrapper:
 *
 *   1. Increments the agent turn counter and gates against maxTurns.
 *   2. Wraps the closure in step.run so the assistant response is
 *      memoized for crash-resume.
 *   3. Inspects result.finishReason to raise classified errors:
 *        "refusal"             → LLMRefusalError
 *        "max_tokens"/"length" → LLMMaxTokensError
 *      JSON-parse failures must be raised by the caller, by detecting
 *      invalid JSON in their closure and throwing LLMInvalidJSONError.
 *
 * Anti-scope: provider routing, prompt templating, and streaming all
 * stay out of this module. See module README.
 */

import type { StepClient } from "@ironflow/core";
import {
  LLMMaxTokensError,
  LLMRefusalError,
  MaxTurnsExceededError,
} from "./errors.js";
import type {
  LLMClient,
  LLMCompleteRequest,
  LLMCompleteResult,
} from "./types.js";

/**
 * Turn counter shared between llm() invocations and AgentContext.turn.
 *
 * Plain mutable object so the AgentContext getter can read the live value
 * without callers needing a reactive abstraction.
 */
export interface TurnCounter {
  value: number;
}

/** Construct a fresh turn counter. */
export function createTurnCounter(): TurnCounter {
  return { value: 0 };
}

/**
 * Build an LLMClient bound to the given step + counter.
 *
 * Exported for use by agent.ts; not part of the public API surface.
 */
export function makeLlm(
  step: StepClient,
  counter: TurnCounter,
  maxTurns: number
): LLMClient {
  return {
    async complete(request: LLMCompleteRequest): Promise<LLMCompleteResult> {
      counter.value += 1;
      if (counter.value > maxTurns) {
        throw new MaxTurnsExceededError(maxTurns);
      }
      const result = await step.run(`llm.turn`, () => request.call());
      classifyResult(result);
      return result;
    },
  };
}

function classifyResult(result: LLMCompleteResult): void {
  const reason = result.finishReason;
  if (!reason) return;
  const normalized = reason.toLowerCase();
  if (normalized === "refusal" || normalized === "safety" || normalized === "content_filter") {
    throw new LLMRefusalError(`provider refused: ${reason}`, {
      details: { finishReason: reason, metadata: result.metadata },
    });
  }
  if (normalized === "max_tokens" || normalized === "length") {
    throw new LLMMaxTokensError(`provider hit max_tokens (${reason})`, {
      details: { finishReason: reason, metadata: result.metadata },
    });
  }
}
