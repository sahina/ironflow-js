/**
 * Run lifecycle frames (`system.run.{runId}.{event}`) and the version filter
 * that keeps a watcher on the newest status.
 */

import type { SubscriptionEvent } from "./types.js";

/**
 * Payload of a `system.run.{runId}.{event}` frame. Step frames
 * (`system.run.{runId}.step.{stepId}.{event}`) have a different shape.
 */
export interface RunEvent {
  id: string;
  functionId: string;
  eventId: string;
  executionMode: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  /**
   * The run row's version as written by the transition this frame announces.
   * It rises with every write to the run. Absent on the `deleted` frame (the
   * row is gone) and on a frame from a server that predates the field; absent or zero versions are unknown.
   */
  version?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: unknown;
  timestamp: string;
}

/**
 * Decides whether a run frame is still worth delivering. See
 * {@link createRunVersionFilter}.
 */
export type RunVersionFilter = (event: SubscriptionEvent) => boolean;

/** Run and step identities remembered before the least recent is evicted. */
const DEFAULT_MAX_RUNS = 10_000;

/**
 * Creates a filter that drops older run and step frames, and late frames for
 * remembered deleted runs.
 *
 * Frames for one run can arrive out of order: a pull worker may poll one node
 * and complete on another, and the `completed` frame can land before the
 * `running` one. A watcher that shows the status of the last frame it got would
 * then show `running` after `completed`.
 *
 * Passes without ranking: any frame outside `system.run.`, a
 * frame with no usable version (unless its run was deleted), and a frame whose version
 * ties the highest seen (one write publishes both `.failed` and `.updated`).
 * A `deleted` frame remembers a tombstone and blocks late run and step frames.
 *
 * Run and step identities share one cache capped at `maxRuns`. Steps rank
 * independently. Eviction forgets ordering and deletion history.
 * One filter belongs to one subscription.
 *
 * @example
 * ```ts
 * const keep = createRunVersionFilter();
 * await client.subscribe("system.run.>", {
 *   onEvent: (event) => {
 *     if (keep(event)) render(event.data as RunEvent);
 *   },
 * });
 * ```
 */
export function createRunVersionFilter(
  options: { maxRuns?: number } = {}
): RunVersionFilter {
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  // A Map iterates in insertion order, so re-inserting on every update keeps
  // the first key the least recently seen.
  const highest = new Map<string, number>();

  return (event) => {
    const parts = event.topic.split(".");
    const isStep = parts.length >= 6 && parts[3] === "step";
    if ((!isStep && parts.length !== 4) || parts[0] !== "system" || parts[1] !== "run") {
      return true;
    }
    const runId = parts[2]!;
    const deleted = !isStep && parts[3] === "deleted";
    if (!deleted && highest.get(runId) === -1) return false;
    const key = isStep ? parts.slice(2, -1).join(".") : runId;
    const version = deleted ? -1 : (event.data as { version?: unknown } | null)?.version;
    if (!deleted && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
      return true;
    }
    const seen = highest.get(key);
    if (!deleted && seen !== undefined && (version as number) < seen) {
      return false;
    }
    highest.delete(key);
    highest.set(key, version as number);
    if (highest.size > maxRuns) {
      highest.delete(highest.keys().next().value as string);
    }
    return true;
  };
}
