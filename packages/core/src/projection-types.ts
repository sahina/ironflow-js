// sdk/js/core/src/projection-types.ts

import { IronflowError } from "./errors.js";
import type { Logger } from "./types.js";

/** Projection execution mode */
export type ProjectionMode = "managed" | "external";

/** Projection status */
export type ProjectionStatus = "active" | "rebuilding" | "paused" | "error";

/** Context passed to projection handlers */
export interface ProjectionContext {
  event: {
    id: string;
    name: string;
    seq: number;
    timestamp: Date;
    /** Cross-cutting metadata (causation, correlation, tenant, trace) */
    metadata?: Record<string, unknown>;
  };
  projection: {
    name: string;
    version: number;
  };
  logger: Logger;
}

/**
 * Handler for managed projections (pure reducer).
 *
 * REQUIRED: the handler MUST be deterministic and idempotent. Same
 * `(state, event)` MUST produce the same `newState`, every invocation.
 * Non-deterministic reducers (`Date.now()`, `new Date()`, `Math.random()`,
 * `crypto.randomUUID()`, env/file reads) diverge under at-least-once delivery
 * and concurrent rebuild/live application — PG-backed rebuild (#486) and the
 * live NATS tail can both call the reducer for the same event, and the same
 * event may arrive multiple times across retries and node failover.
 *
 * Derive timestamps from `event.timestamp` (available via `ctx.event.timestamp`),
 * IDs from `event.data`. Return a fresh state object; managed handlers MUST NOT
 * perform side effects (network, DB writes, logging-as-intent). External I/O
 * requires `mode: "external"`.
 *
 * See `docs/explanation/projections.md#reducer-contract-managed-mode`.
 */
export type ManagedProjectionHandler<TState = unknown, TEvent = unknown> = (
  state: TState,
  event: TEvent & { name: string; data: unknown; metadata?: Record<string, unknown> },
  ctx: ProjectionContext
) => TState;

/** Handler for external projections (side effects) */
export type ExternalProjectionHandler<TEvent = unknown> = (
  event: TEvent & { name: string; data: unknown; metadata?: Record<string, unknown> },
  ctx: ProjectionContext
) => void | Promise<void>;

/** Configuration for creating a projection */
export interface ProjectionConfig<TState = unknown, TEvent = unknown> {
  /** Unique projection name */
  name: string;
  /** Event names to subscribe to (supports wildcards like "order.*") */
  events: string[];
  /** Execution mode — auto-detected from initialState if omitted */
  mode?: ProjectionMode;
  /** Handler function */
  handler: ManagedProjectionHandler<TState, TEvent> | ExternalProjectionHandler<TEvent>;
  /** Initial state factory (required for managed, absent for external) */
  initialState?: () => TState;
  /** JSONPath for partition key extraction (e.g., "$.data.customerId") */
  partitionKey?: string;
  /** Max retries per event (default 3) */
  maxRetries?: number;
  /** Batch size for polling (default 100) */
  batchSize?: number;
}

/** A defined projection instance */
export interface IronflowProjection<TState = unknown, TEvent = unknown> {
  config: ProjectionConfig<TState, TEvent>;
}

/** Projection status response */
export interface ProjectionStatusInfo {
  name: string;
  status: ProjectionStatus;
  mode: ProjectionMode;
  lastEventSeq: number;
  lag: number;
  errorMessage?: string;
  updatedAt: Date;
}

/**
 * Projection state query result.
 *
 * Returned by `client.projections.get()` (Node) and `ironflow.getProjection()`
 * (browser) after `peelProjectionEnvelope()` strips the server wire shape.
 *
 * Field provenance:
 *   - name, version, mode, status, lastEventSeq, updatedAt, errorMessage:
 *     registry-level (envelope) — registry is authoritative for projection
 *     metadata; inner state-row values are ignored when both exist.
 *   - partition, state, lastEventId, lastEventTime: state-row level (inner)
 *
 * `lastEventTime` is `undefined` when no state row exists yet (projection
 * registered, no events applied). `state` is empty (`{}`) in that case.
 *
 * `status` and `errorMessage` come from the registry envelope so consumers
 * see error / paused projections without a separate `getProjectionStatus`
 * call. `errorMessage` is omitted when status is healthy.
 */
export interface ProjectionStateResult<TState = unknown> {
  name: string;
  partition: string;
  state: TState;
  lastEventId: string;
  lastEventTime?: Date;
  lastEventSeq: number;
  version: number;
  mode: ProjectionMode;
  status?: ProjectionStatus;
  errorMessage?: string;
  updatedAt: Date;
}

/**
 * Strip the server REST envelope and return a flat ProjectionStateResult.
 *
 * Server wire shape (`GET /api/v1/projections/{name}`):
 *   {
 *     name, version, mode, last_event_seq, updated_at,  // registry-level
 *     state: {                                          // optional inner state row
 *       projection_name, environment_id, partition_key,
 *       state: <user state>,
 *       last_event_id, last_event_seq, last_event_time, version, updated_at
 *     }
 *   }
 *
 * Behavior:
 *   - Outer `state` absent or null: returns empty user state with
 *     partition = `requestedPartition ?? "__global__"`, lastEventTime
 *     undefined. Normal for a freshly-registered projection.
 *   - Inner `state.state` field absent: throws `IronflowError` with code
 *     `PROJECTION_ENVELOPE_DRIFT`. Indicates server contract drift.
 *   - Inner `state.state` is null: treated as empty `{}`.
 *
 * `requestedPartition` is the partition the caller asked for. Server omits
 * partition_key from the envelope when no state row exists, so the helper
 * echoes the requested key rather than silently defaulting to `__global__`.
 */
export function peelProjectionEnvelope<TState = unknown>(
  raw: unknown,
  requestedPartition?: string
): ProjectionStateResult<TState> {
  if (raw === null || typeof raw !== "object") {
    throw new IronflowError(
      "projection envelope drift: expected object response",
      { code: "PROJECTION_ENVELOPE_DRIFT", retryable: false }
    );
  }
  const env = raw as Record<string, unknown>;

  if (typeof env["name"] !== "string") {
    throw new IronflowError(
      "projection envelope drift: missing name",
      { code: "PROJECTION_ENVELOPE_DRIFT", retryable: false }
    );
  }

  const partitionFallback = requestedPartition ?? "__global__";
  const inner = env["state"];

  if (inner === undefined || inner === null) {
    return {
      name: env["name"] as string,
      partition: partitionFallback,
      state: {} as TState,
      lastEventId: "",
      lastEventTime: undefined,
      lastEventSeq: toNumber(env["last_event_seq"]) ?? 0,
      version: toNumber(env["version"]) ?? 0,
      mode: toMode(env["mode"]),
      status: toStatus(env["status"]),
      errorMessage: toOptionalString(env["error_message"]),
      updatedAt: toDate(env["updated_at"]) ?? new Date(0),
    };
  }

  if (typeof inner !== "object") {
    throw new IronflowError(
      "projection envelope drift: state field is not an object",
      { code: "PROJECTION_ENVELOPE_DRIFT", retryable: false }
    );
  }
  const innerObj = inner as Record<string, unknown>;

  if (!("state" in innerObj)) {
    throw new IronflowError(
      "projection envelope drift: expected state.state (inner user state field missing)",
      { code: "PROJECTION_ENVELOPE_DRIFT", retryable: false }
    );
  }

  const userState = innerObj["state"];
  // Server emits `partition_key: ""` (no omitempty on internal/store/models.go:554)
  // when no partition is set; fall back to the requested partition rather than
  // returning empty string. Matches Go peel behavior.
  const innerPartition = innerObj["partition_key"];
  const partition =
    typeof innerPartition === "string" && innerPartition !== ""
      ? innerPartition
      : partitionFallback;
  // Registry-level fields (envelope) are authoritative for projection
  // metadata. Inner state-row values for the same fields can lag during
  // rebuild and are intentionally ignored.
  return {
    name: env["name"] as string,
    partition,
    state: (userState ?? {}) as TState,
    lastEventId: (innerObj["last_event_id"] as string | undefined) ?? "",
    lastEventTime: toDate(innerObj["last_event_time"]),
    lastEventSeq: toNumber(env["last_event_seq"]) ?? 0,
    version: toNumber(env["version"]) ?? 0,
    mode: toMode(env["mode"]),
    status: toStatus(env["status"]),
    errorMessage: toOptionalString(env["error_message"]),
    updatedAt:
      toDate(env["updated_at"]) ?? toDate(innerObj["updated_at"]) ?? new Date(0),
  };
}

function toOptionalString(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  return undefined;
}

function toStatus(v: unknown): ProjectionStatus | undefined {
  if (
    v === "active" ||
    v === "rebuilding" ||
    v === "paused" ||
    v === "error"
  ) {
    return v;
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function toDate(v: unknown): Date | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      // Server emits Go's `time.Time{}` zero value as "0001-01-01T00:00:00Z"
      // (no omitempty on `internal/store/models.go:558`). Treat as "no events
      // processed yet" instead of a real epoch-adjacent timestamp.
      if (d.getUTCFullYear() <= 1) return undefined;
      return d;
    }
    throw new IronflowError(
      `projection envelope drift: invalid timestamp ${JSON.stringify(v)}`,
      { code: "PROJECTION_ENVELOPE_DRIFT", retryable: false }
    );
  }
  return undefined;
}

function toMode(v: unknown): ProjectionMode {
  if (v === "managed" || v === "external") return v;
  return "managed";
}

/** Options for getProjection */
export interface GetProjectionOptions {
  partition?: string;
}

/** Options for rebuildProjection */
export interface RebuildProjectionOptions {
  partition?: string;
  fromEventId?: string;
  dryRun?: boolean;
}

/** Input for creating a SQL-backed projection */
export interface CreateSQLProjectionInput {
  /** Unique projection name */
  name: string;
  /** CREATE TABLE DDL for the projection table (must use proj_ prefix) */
  tableSql: string;
  /** Map of event_name → parameterized SQL handler (INSERT/UPDATE/DELETE) */
  eventHandlers: Record<string, string>;
  /** Event names to subscribe to */
  events: string[];
  /** Optional description */
  description?: string;
}

/** Options for querying a SQL projection */
export interface QuerySQLProjectionOptions {
  /** Optional WHERE clause (e.g., "status = 'OPEN'") */
  where?: string;
  /** Optional ORDER BY clause (e.g., "created_at DESC") */
  orderBy?: string;
  /** Max rows to return (default 100) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/** Result of querying a SQL projection */
export interface SQLProjectionQueryResult {
  /** Column names */
  columns: string[];
  /** Row data (each row is an array of string values matching column order) */
  rows: string[][];
  /** Total matching row count (before limit/offset) */
  totalCount: number;
}

/** Callbacks for subscribeToProjection */
export interface ProjectionSubscriptionCallbacks<TState = unknown> {
  onUpdate: (state: TState, event: { id: string; name: string }) => void;
  onError?: (error: Error) => void;
}
