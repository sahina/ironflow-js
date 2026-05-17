/**
 * `ironflow.agents.subscribe()` — typed wrapper over `client.subscribe()`
 * for an agent run's event stream.
 *
 * Spec: see ./spec.md
 */

import {
  ValidationError,
  type SubscriptionEvent,
  type Subscription,
} from "@ironflow/core";

import type {
  AgentClientLike,
  AgentProgressEvent,
  AgentStepEvent,
  AgentSubscribeCallbacks,
} from "./types.js";

const MAX_RUN_ID_LENGTH = 128;

// Permits server-issued runIds (e.g., `run_<uuid>`, `run-2025-...`) but
// rejects NATS subject metacharacters that would widen the subscribe to
// other runs (`*`, `>`, `.`) or break the topic shape.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new ValidationError(
      "agents.subscribe: runId must be a non-empty string"
    );
  }
  if (runId.length > MAX_RUN_ID_LENGTH) {
    throw new ValidationError(
      `agents.subscribe: runId exceeds ${MAX_RUN_ID_LENGTH} chars`
    );
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ValidationError(
      "agents.subscribe: runId may only contain [A-Za-z0-9_-] (no NATS metacharacters)"
    );
  }
}

interface RunEventData {
  status?: string;
  output?: unknown;
  error?: { message?: string; code?: string } | string;
}

/**
 * Promise-returning wrapper. Returns a Subscription whose `unsubscribe()`
 * is idempotent.
 *
 * Topic dispatch:
 *   system.run.{runId}.completed             → onComplete
 *   system.run.{runId}.failed                → onFailed
 *   system.run.{runId}.cancelled             → onCancelled
 *   system.run.{runId}.{created|updated|resumed} → onProgress
 *   system.run.{runId}.step.{stepId}.{type}  → onStep
 */
export async function subscribe(
  client: AgentClientLike,
  runId: string,
  callbacks: AgentSubscribeCallbacks,
  opts: { replay?: number } = {}
): Promise<Subscription> {
  validateRunId(runId);

  const sub = await client.subscribe<RunEventData>(
    `system.run.${runId}.>`,
    {
      // Default replay 1000 covers events emitted between `agents.invoke`
      // returning a runId via `onRunStarted` and this subscribe attaching.
      replay: opts.replay ?? 1000,
      onEvent: (event: SubscriptionEvent<RunEventData>) =>
        dispatch(event, runId, callbacks),
      onError: callbacks.onError,
    }
  );

  // Wrap the underlying unsubscribe to make it idempotent.
  let unsubscribed = false;
  const wrapped: Subscription = {
    id: (sub as Subscription).id ?? "",
    pattern: (sub as Subscription).pattern ?? `system.run.${runId}.>`,
    connectionState:
      (sub as Subscription).connectionState ?? "connected",
    unsubscribe(): void {
      if (unsubscribed) return;
      unsubscribed = true;
      try {
        sub.unsubscribe();
      } catch {
        /* swallow — idempotent */
      }
    },
  };
  return wrapped;
}

function dispatch(
  event: SubscriptionEvent<RunEventData>,
  runId: string,
  callbacks: AgentSubscribeCallbacks
): void {
  const topic = event.topic;
  const stepPrefix = `system.run.${runId}.step.`;

  if (topic.startsWith(stepPrefix)) {
    if (!callbacks.onStep) return;
    const remainder = topic.slice(stepPrefix.length); // "{stepId}.{type}"
    const dotIdx = remainder.indexOf(".");
    const stepId = dotIdx === -1 ? remainder : remainder.slice(0, dotIdx);
    const type = dotIdx === -1 ? "" : remainder.slice(dotIdx + 1);
    const stepEvent: AgentStepEvent = {
      topic,
      stepId,
      type,
      data: event.data,
    };
    callbacks.onStep(stepEvent);
    return;
  }

  if (topic.endsWith(".completed")) {
    callbacks.onComplete?.({ output: event.data?.output });
    return;
  }
  if (topic.endsWith(".failed")) {
    const err = event.data?.error;
    if (typeof err === "string") {
      callbacks.onFailed?.({ message: err });
    } else if (err && typeof err === "object") {
      callbacks.onFailed?.({
        message: err.message ?? "Run failed",
        code: err.code,
      });
    } else {
      callbacks.onFailed?.({ message: "Run failed" });
    }
    return;
  }
  if (topic.endsWith(".cancelled")) {
    callbacks.onCancelled?.();
    return;
  }

  // Non-terminal: created / updated / resumed.
  if (callbacks.onProgress) {
    const progressEvent: AgentProgressEvent = {
      topic,
      status: event.data?.status,
      data: event.data,
    };
    callbacks.onProgress(progressEvent);
  }
}
