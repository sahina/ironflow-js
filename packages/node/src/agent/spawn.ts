/**
 * spawn() — durable sub-agent invocation.
 *
 * Wraps step.invoke (or step.invokeAsync for fire-and-forget) so the
 * sub-agent run is part of the parent's durable plan. Crash-resume
 * applies: re-running the parent after a crash replays the cached
 * sub-agent output without re-invoking.
 *
 * Parent ↔ child run linkage is recorded server-side by the existing
 * invoke implementation. spawn() doesn't add new linkage state.
 */

import type { StepClient } from "@ironflow/core";
import type { SpawnFn, SpawnOptions, SpawnResult } from "./types.js";

/**
 * Build a SpawnFn bound to the given step client.
 *
 * Exported for use by agent.ts; not part of the public API surface.
 */
export function makeSpawn(step: StepClient): SpawnFn {
  return async function spawn<TInput = unknown, TOutput = unknown>(
    name: string,
    options: SpawnOptions<TInput>
  ): Promise<SpawnResult<TOutput>> {
    const stepName = `spawn.${name}`;
    const shouldAwait = options.await !== false;

    if (shouldAwait) {
      const output = await step.invoke<TOutput>(options.functionId, options.input);
      return { output };
    }

    const handle = await step.run(stepName, () =>
      step.invokeAsync(options.functionId, options.input)
    );
    return { runId: handle.runId };
  };
}
