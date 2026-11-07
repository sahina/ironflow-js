/**
 * Types and wire normalizers for definition history, executable deployments,
 * raw SQL and the capacity and debounce ops views (#2948).
 *
 * The Connect routes answer in protobuf JSON: camelCase, int64 as a string,
 * and zero values (false, 0, "") left out. The REST ops routes answer in
 * snake_case with plain numbers, so their types keep the wire's field names and
 * only their timestamps are decoded.
 */

import { optionalTimestampFromWire, timestampFromWire } from "./timestamp-wire.js";

// ── Definition history (projections and event schemas) ──────────────────

export interface DefinitionHistoryOptions {
  /** Page size. Omitted means 50; the server caps it at 200. */
  limit?: number;
  /** Exclusive cursor. Pass the previous page's `nextBeforeRevision`. */
  beforeRevision?: number;
}

export interface ProjectionDefinition {
  name: string;
  environmentId: string;
  version: number;
  events: string[];
  partitionKey: string;
  mode: string;
  type: string;
  sqlDefinition: string;
  eventHandlers: Record<string, string>;
  description: string;
}

export interface SchemaDefinition {
  eventName: string;
  environmentId: string;
  version: number;
  /** The archived JSON Schema document, verbatim. */
  schemaJson: string;
  description: string;
}

/** A definition as it was before the change that archived it. */
export interface DefinitionHistoryEntry<TDefinition> {
  eventId: string;
  revision: number;
  previousDefinition: TDefinition;
  actorId: string;
  changeReason: string;
  changeType: string;
  recordedAt: Date;
}

export interface DefinitionHistoryPage<TDefinition> {
  entries: DefinitionHistoryEntry<TDefinition>[];
  hasMore: boolean;
  /** 0 when the history is exhausted. */
  nextBeforeRevision: number;
}

export type ProjectionHistoryEntry = DefinitionHistoryEntry<ProjectionDefinition>;
export type ProjectionHistoryPage = DefinitionHistoryPage<ProjectionDefinition>;
export type SchemaHistoryEntry = DefinitionHistoryEntry<SchemaDefinition>;
export type SchemaHistoryPage = DefinitionHistoryPage<SchemaDefinition>;

type Wire = Record<string, unknown>;

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Request fields for a history page. int64 travels as a string. */
export function definitionHistoryRequest(options: DefinitionHistoryOptions = {}): Record<string, unknown> {
  return {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.beforeRevision !== undefined ? { beforeRevision: String(options.beforeRevision) } : {}),
  };
}

export function projectionDefinitionFromWire(raw: unknown): ProjectionDefinition {
  const d = (raw ?? {}) as Wire;
  return {
    name: str(d.name),
    environmentId: str(d.environmentId),
    version: num(d.version),
    events: Array.isArray(d.events) ? (d.events as string[]) : [],
    partitionKey: str(d.partitionKey),
    mode: str(d.mode),
    type: str(d.type),
    sqlDefinition: str(d.sqlDefinition),
    eventHandlers: (d.eventHandlers as Record<string, string> | undefined) ?? {},
    description: str(d.description),
  };
}

export function schemaDefinitionFromWire(raw: unknown): SchemaDefinition {
  const d = (raw ?? {}) as Wire;
  return {
    eventName: str(d.eventName),
    environmentId: str(d.environmentId),
    version: num(d.version),
    schemaJson: str(d.schemaJson),
    description: str(d.description),
  };
}

export function definitionHistoryEntryFromWire<TDefinition>(
  raw: unknown,
  definition: (raw: unknown) => TDefinition,
): DefinitionHistoryEntry<TDefinition> {
  const e = (raw ?? {}) as Wire;
  return {
    eventId: str(e.eventId),
    revision: num(e.revision),
    previousDefinition: definition(e.previousDefinition),
    actorId: str(e.actorId),
    changeReason: str(e.changeReason),
    changeType: str(e.changeType),
    recordedAt: timestampFromWire("definitionHistoryEntry.recordedAt", e.recordedAt),
  };
}

export function definitionHistoryPageFromWire<TDefinition>(
  raw: unknown,
  definition: (raw: unknown) => TDefinition,
): DefinitionHistoryPage<TDefinition> {
  const r = (raw ?? {}) as Wire;
  return {
    entries: (Array.isArray(r.entries) ? r.entries : []).map((e) => definitionHistoryEntryFromWire(e, definition)),
    hasMore: r.hasMore === true,
    nextBeforeRevision: num(r.nextBeforeRevision),
  };
}

// ── Executable deployments (ADR 0081) ───────────────────────────────────

/**
 * The highest ExecutionSnapshot schema this SDK knows. The server refuses a
 * newer one rather than store an identity it cannot represent. Raise it with
 * the proto.
 *
 * This is the ceiling, not what every request declares: `registerDeploymentRequest`
 * declares 2 only when the snapshot uses a schema-2 field (`circuitBreaker`,
 * `throttle`, `retry.onExhausted`) and 1 otherwise, so a plain snapshot still
 * registers against an engine that predates schema 2.
 */
export const DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION = 2;

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** Lowest snapshot schema that can represent `snapshot`; protojson accepts camelCase and snake_case keys. */
function snapshotSchemaVersionFor(snapshot: Record<string, unknown> | undefined): number {
  if (!snapshot) return 1;
  const retry = (snapshot.retry ?? {}) as Record<string, unknown>;
  const usesV2 =
    hasValue(snapshot.circuitBreaker) ||
    hasValue(snapshot.circuit_breaker) ||
    hasValue(snapshot.throttle) ||
    hasValue(retry.onExhausted) ||
    hasValue(retry.on_exhausted);
  return usesV2 ? DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION : 1;
}

export interface RegisterDeploymentInput {
  functionId: string;
  /** Chosen by you, never reused: 1-128 ASCII letters, digits, `.`, `_` or `-`. */
  deploymentId: string;
  /** `sha256:` plus 64 lowercase hex digits. */
  artifactDigest: string;
  /**
   * The ExecutionSnapshot in its ConnectRPC JSON form, for example
   * `{ triggers: [{ event: "order.placed" }], timeoutMs: 30000 }`.
   */
  snapshot?: Record<string, unknown>;
  mode: "push" | "pull";
  /** Required for push, must be omitted for pull. */
  endpointUrl?: string;
}

export interface Deployment {
  environmentId: string;
  functionId: string;
  deploymentId: string;
  artifactDigest: string;
  /** The stored ExecutionSnapshot in its ConnectRPC JSON form. */
  snapshot: Record<string, unknown>;
  mode: "push" | "pull" | "unspecified";
  endpointUrl: string;
  createdBy: string;
  createdAt: Date;
}

export interface RegisterDeploymentResult {
  deployment: Deployment;
  /** False when an identical registration already existed. */
  created: boolean;
}

export interface ListDeploymentsOptions {
  limit?: number;
  offset?: number;
}

export interface FunctionExecutionRouting {
  functionId: string;
  mode: "legacy" | "adopting" | "versioned" | "unspecified";
  /** Empty unless `mode` is `versioned`. */
  activeDeploymentId: string;
  routingRevision: number;
  /** Non-empty only while `mode` is `adopting`. */
  transitionId: string;
  transitionStartedAt?: Date;
  /** Absent while the function has no routing row. */
  updatedAt?: Date;
}

function enumSuffix(value: unknown, prefix: string): string {
  const s = str(value);
  return s.startsWith(prefix) ? s.slice(prefix.length).toLowerCase() : "unspecified";
}

export function registerDeploymentRequest(input: RegisterDeploymentInput): Record<string, unknown> {
  return {
    functionId: input.functionId,
    deploymentId: input.deploymentId,
    artifactDigest: input.artifactDigest,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    mode: `EXECUTION_MODE_${input.mode.toUpperCase()}`,
    ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
    snapshotSchemaVersion: snapshotSchemaVersionFor(input.snapshot),
  };
}

export function deploymentFromWire(raw: unknown): Deployment {
  const d = (raw ?? {}) as Wire;
  return {
    environmentId: str(d.environmentId),
    functionId: str(d.functionId),
    deploymentId: str(d.deploymentId),
    artifactDigest: str(d.artifactDigest),
    snapshot: (d.snapshot as Record<string, unknown> | undefined) ?? {},
    mode: enumSuffix(d.mode, "EXECUTION_MODE_") as Deployment["mode"],
    endpointUrl: str(d.endpointUrl),
    createdBy: str(d.createdBy),
    createdAt: timestampFromWire("deployment.createdAt", d.createdAt),
  };
}

export function executionRoutingFromWire(raw: unknown): FunctionExecutionRouting {
  const r = (raw ?? {}) as Wire;
  return {
    functionId: str(r.functionId),
    mode: enumSuffix(r.mode, "FUNCTION_ROUTING_MODE_") as FunctionExecutionRouting["mode"],
    activeDeploymentId: str(r.activeDeploymentId),
    routingRevision: num(r.routingRevision),
    transitionId: str(r.transitionId),
    transitionStartedAt: optionalTimestampFromWire("executionRouting.transitionStartedAt", r.transitionStartedAt),
    updatedAt: optionalTimestampFromWire("executionRouting.updatedAt", r.updatedAt),
  };
}

// ── Raw SQL (QueryService/ExecuteSQL) ───────────────────────────────────

export interface ExecuteSQLOptions {
  /** Server default 5000, maximum 30000. */
  timeoutMs?: number;
  /** Server default 1000, maximum 10000. */
  maxRows?: number;
}

export interface ExecuteSQLResult {
  columns: string[];
  /** One object per row, keyed by column. Every cell is a string; SQL NULL is `""`. */
  rows: Record<string, string>[];
  totalRows: number;
}

export function executeSQLResultFromWire(raw: unknown): ExecuteSQLResult {
  const r = (raw ?? {}) as Wire;
  const columns = Array.isArray(r.columns) ? (r.columns as string[]) : [];
  const rows = (Array.isArray(r.rows) ? r.rows : []).map((row) => {
    const values = ((row as Wire).values as string[] | undefined) ?? [];
    return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? ""]));
  });
  return { columns, rows, totalRows: num(r.totalRows) };
}

// ── Capacity and debounce ops views (REST, snake_case) ──────────────────

/** Filters for a capacity view. Leases and credits ignore `function`. */
export interface CapacityListOptions {
  env?: string;
  function?: string;
  /** Omitted means 100; the server caps it at 1000. */
  limit?: number;
}

export interface CapacityLane {
  lane_id: string;
  environment_id: string;
  function_id: string;
  scope: string;
  scalar_type: string;
  limit: number;
  active_reserved: number;
  config_version: number;
  created_at: Date;
  last_used_at: Date;
}

export interface CapacityQueueEntry {
  queue_seq: number;
  run_id: string;
  execution_seq: number;
  execution_mode: string;
  function_id: string;
  function_version: number | null;
  lane_id: string | null;
  timeout_ms: number | null;
  environment_id: string;
  first_enqueued_at: Date;
  eligible_at: Date;
  blocking_reason: string;
  reservation_owner: string | null;
  /** Absent until the entry holds a reservation. */
  reservation_expires_at?: Date;
  created_at: Date;
}

/** `function_id` is always `""` on this view; match a lease by `run_id`. */
export interface CapacityLease {
  lease_id: string;
  run_id: string;
  execution_seq: number;
  lane_id: string | null;
  lease_token_hash: string;
  activated_at: Date;
  expires_at: Date;
  engine_node_id: string | null;
  environment_id: string;
  function_id: string;
}

export interface CapacityBucket {
  environment_id: string;
  function_id: string;
  lane_id: string | null;
  /** Absent until the bucket first dispatches. */
  last_dispatched_at?: Date;
  created_at: Date;
}

export interface CapacityWorkerSession {
  session_id: string;
  worker_id: string;
  engine_node_id: string;
  environment_id: string;
  labels?: Record<string, string>;
  protocol_caps?: Record<string, unknown>;
  draining: boolean;
  heartbeat_expiry: Date;
  created_at: Date;
}

export interface CapacityWorkerCredit {
  credit_id: string;
  environment_id: string;
  worker_id: string;
  session_id: string;
  engine_node_id: string;
  slot_ordinal: number;
  expires_at: Date;
  claimed: boolean;
  claimed_run_id: string;
  claimed_execution_seq: number;
  created_at: Date;
}

export interface CapacityStat {
  environment_id: string;
  function_id: string;
  active_leases: number;
  lane_limit: number;
  queued: number;
  reservations: number;
  oldest_queue_age_seconds: number;
}

export interface DebounceEntry {
  environment_id: string;
  function_id: string;
  debounce_key: string;
  event_id: string;
  function_version: number;
  period_ms: number;
  armed_at: Date;
  fires_at: Date;
}

/** The query string for a capacity view, with its leading `?`, or `""`. */
export function capacityQuery(options: CapacityListOptions = {}): string {
  const q = new URLSearchParams();
  if (options.env) q.set("env_id", options.env);
  if (options.function) q.set("function", options.function);
  if (options.limit !== undefined) q.set("limit", String(options.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function capacityLaneFromWire(raw: Record<string, unknown>): CapacityLane {
  return {
    ...raw,
    created_at: timestampFromWire("CapacityLane.created_at", raw.created_at),
    last_used_at: timestampFromWire("CapacityLane.last_used_at", raw.last_used_at),
  } as unknown as CapacityLane;
}

export function capacityQueueEntryFromWire(raw: Record<string, unknown>): CapacityQueueEntry {
  return {
    ...raw,
    first_enqueued_at: timestampFromWire("CapacityQueueEntry.first_enqueued_at", raw.first_enqueued_at),
    eligible_at: timestampFromWire("CapacityQueueEntry.eligible_at", raw.eligible_at),
    created_at: timestampFromWire("CapacityQueueEntry.created_at", raw.created_at),
    reservation_expires_at: optionalTimestampFromWire("CapacityQueueEntry.reservation_expires_at", raw.reservation_expires_at),
  } as unknown as CapacityQueueEntry;
}

export function capacityLeaseFromWire(raw: Record<string, unknown>): CapacityLease {
  return {
    ...raw,
    activated_at: timestampFromWire("CapacityLease.activated_at", raw.activated_at),
    expires_at: timestampFromWire("CapacityLease.expires_at", raw.expires_at),
  } as unknown as CapacityLease;
}

export function capacityBucketFromWire(raw: Record<string, unknown>): CapacityBucket {
  return {
    ...raw,
    created_at: timestampFromWire("CapacityBucket.created_at", raw.created_at),
    last_dispatched_at: optionalTimestampFromWire("CapacityBucket.last_dispatched_at", raw.last_dispatched_at),
  } as unknown as CapacityBucket;
}

export function capacityWorkerSessionFromWire(raw: Record<string, unknown>): CapacityWorkerSession {
  return {
    ...raw,
    heartbeat_expiry: timestampFromWire("CapacityWorkerSession.heartbeat_expiry", raw.heartbeat_expiry),
    created_at: timestampFromWire("CapacityWorkerSession.created_at", raw.created_at),
  } as unknown as CapacityWorkerSession;
}

export function capacityWorkerCreditFromWire(raw: Record<string, unknown>): CapacityWorkerCredit {
  return {
    ...raw,
    expires_at: timestampFromWire("CapacityWorkerCredit.expires_at", raw.expires_at),
    created_at: timestampFromWire("CapacityWorkerCredit.created_at", raw.created_at),
  } as unknown as CapacityWorkerCredit;
}

export function debounceEntryFromWire(raw: Record<string, unknown>): DebounceEntry {
  return {
    ...raw,
    armed_at: timestampFromWire("DebounceEntry.armed_at", raw.armed_at),
    fires_at: timestampFromWire("DebounceEntry.fires_at", raw.fires_at),
  } as unknown as DebounceEntry;
}
