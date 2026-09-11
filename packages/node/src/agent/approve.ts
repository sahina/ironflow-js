/**
 * approve() — durable human-approval gate.
 *
 * Wraps step.waitForEvent on a deterministic event name derived from the
 * agent run + approval name. TTL expiry fails the run with
 * "waitForEvent timed out" on step "approve.{name}". The engine does not
 * resume the handler, so approve() does not return a timeout result.
 *
 * Approval events follow the convention:
 *   name:      "agent.approve.{name}"
 *   filter:    runId === ctx.run.id
 *   data shape:
 *     { approved: boolean, approver?: string, payload?, reason? }
 */

import type { StepClient } from "@ironflow/core";
import { normalizeDuration } from "./internal.js";
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
