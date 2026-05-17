/**
 * approve() — durable human-approval gate.
 *
 * Wraps step.waitForEvent on a deterministic event name derived from the
 * agent run + approval name. The default behavior on TTL elapse is to
 * resolve with approved=false, reason="timeout" — explicit rejection vs
 * timeout is observable to the caller via the returned reason field.
 *
 * Approval events follow the convention:
 *   name:      "agent.approve.{name}"
 *   filter:    runId === ctx.run.id
 *   data shape:
 *     { approved: boolean, approver?: string, payload?, reason? }
 */

import type { StepClient } from "@ironflow/core";
import { escapeMatchValue, normalizeDuration } from "./internal.js";
import type { ApproveFn, ApproveOptions, ApproveResult } from "./types.js";

const APPROVE_EVENT_PREFIX = "agent.approve.";

/**
 * Build an ApproveFn bound to the given step + run.
 *
 * Exported for use by agent.ts; not part of the public API surface.
 */
export function makeApprove(step: StepClient, runId: string): ApproveFn {
  return async function approve<TPayload = unknown, TResult = unknown>(
    name: string,
    options: ApproveOptions<TPayload>
  ): Promise<ApproveResult<TResult>> {
    const eventName = APPROVE_EVENT_PREFIX + name;

    const event = await step.waitForEvent<ApprovalEventData<TResult>>(
      `approve.${name}`,
      {
        event: eventName,
        timeout: normalizeDuration(options.ttl),
        match: `data.runId == "${escapeMatchValue(runId)}"`,
      }
    );

    if (event === null || event === undefined) {
      return { approved: false, reason: "timeout" };
    }

    const data = event.data;
    return {
      approved: Boolean(data?.approved),
      approver: data?.approver,
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
