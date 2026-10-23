/**
 * approve() — durable human-approval gate.
 *
 * Sugar over step.waitForEvent. The caller chooses the event name; the
 * engine has no approval concept. The approver emits that same name with
 * { runId, approved } through any client (REST POST /api/v1/events, Connect
 * Emit, CLI, SDK, webhook). TTL expiry fails the run with
 * "waitForEvent timed out" on step "approve.{event}". The engine does not
 * resume the handler, so approve() does not return a timeout result.
 *
 * The wait matches the event name and runId === ctx.run.id:
 *   data shape:
 *     { runId: string, approved: boolean, approver?: string, payload?, reason? }
 */

import type { StepClient } from "@ironflow/core";
import { normalizeDuration } from "./internal.js";
import type { ApproveFn, ApproveOptions, ApproveResult } from "./types.js";

/**
 * Build an ApproveFn bound to the given step + run.
 *
 * Exported for use by agent.ts; not part of the public API surface.
 */
export function makeApprove(step: StepClient, runId: string): ApproveFn {
  return async function approve<TPayload = unknown, TResult = unknown>(
    eventName: string,
    options: ApproveOptions<TPayload>
  ): Promise<ApproveResult<TResult>> {
    if (typeof eventName !== "string" || eventName.trim() === "") {
      throw new Error("approve(): event must be a non-empty string");
    }

    // The SDK escapes the step name into the step ID, so any event name is a valid step name.
    const event = await step.waitForEvent<ApprovalEventData<TResult>>(
      `approve.${eventName}`,
      {
        event: eventName,
        payload: options.payload,
        timeout: normalizeDuration(options.ttl),
        match: "data.runId",
        matchValue: runId,
      }
    );

    const data = event.data;
    return {
      approved: Boolean(data?.approved),
      approver: data?.approver,
      emittedBy: event.emittedBy,
      payload: data?.payload,
      reason: data?.reason,
    };
  };
}

interface ApprovalEventData<TPayload = unknown> {
  runId: string;
  approved: boolean;
  approver?: string;
  payload?: TPayload;
  reason?: string;
}
