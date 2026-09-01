/**
 * Zod Schemas for Runtime Validation
 *
 * These schemas validate incoming data from external sources (API responses,
 * WebSocket messages, webhook payloads) to ensure type safety at runtime.
 */

import { z } from "zod";
import { SchemaValidationError } from "./errors.js";

// ============================================================================
// Run Status
// ============================================================================

export const RunStatusSchema = z.enum([
  // @deprecated The engine no longer produces "pending" as of #1222 (run status
  // "pending" retired). Retained for source/wire compatibility with older runs.
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
  // Capacity lifecycle (#1222): a run queued and eligible for a dispatch slot,
  // and a run queued but backing off (retry delay / recovery grace) before it
  // becomes eligible.
  "waiting_for_capacity",
  "waiting",
]);

/**
 * Run statuses as encoded by the default protobuf JSON codec.
 *
 * `RUN_STATUS_UNSPECIFIED` and unknown future values are rejected instead of
 * being presented to callers as a different status.
 */
export const RunStatusWireSchema = z
  .enum([
    "RUN_STATUS_RUNNING",
    "RUN_STATUS_COMPLETED",
    "RUN_STATUS_FAILED",
    "RUN_STATUS_CANCELLED",
    "RUN_STATUS_PAUSED",
    "RUN_STATUS_WAITING_FOR_CAPACITY",
    "RUN_STATUS_WAITING",
  ])
  .transform((status) =>
    RunStatusSchema.parse(status.slice("RUN_STATUS_".length).toLowerCase())
  );

/** Convert a protobuf JSON run status into the public SDK status. */
export function runStatusFromWire(value: unknown) {
  const result = RunStatusWireSchema.safeParse(value);
  if (!result.success) {
    const validationErrors = result.error.issues.map((issue) => issue.message);
    throw new SchemaValidationError(
      `Invalid run status from server: ${String(value)}`,
      { validationErrors, cause: result.error }
    );
  }
  return result.data;
}

/**
 * Convert a public SDK run status into its protobuf JSON name.
 *
 * Status filters land on a protobuf enum field, and Connect unmarshals with
 * `DiscardUnknown`, which drops unrecognized enum VALUES — not just unknown
 * fields. A non-canonical spelling is therefore never rejected: the field is
 * silently zeroed to `RUN_STATUS_UNSPECIFIED`, which the server reads as
 * "no filter", so the caller gets unfiltered results and no error. This
 * function is the only place that mistake is caught (#1919).
 *
 * `RunStatusSchema` still accepts the retired "pending", but the proto RESERVES
 * `RUN_STATUS_PENDING`, so a bare uppercase transform would mint exactly the
 * kind of plausible-looking value the server discards. The accepted set here is
 * the wire enum, not the public enum.
 */
// A Map, not an object literal: a plain object would resolve inherited keys, so
// runStatusToWire("toString") would return a function instead of throwing, and
// JSON.stringify would then drop the status field entirely — silently sending
// an unfiltered ListRuns request, the exact failure this function exists to stop.
const RUN_STATUS_TO_WIRE = new Map<string, string>([
  ["running", "RUN_STATUS_RUNNING"],
  ["completed", "RUN_STATUS_COMPLETED"],
  ["failed", "RUN_STATUS_FAILED"],
  ["cancelled", "RUN_STATUS_CANCELLED"],
  ["paused", "RUN_STATUS_PAUSED"],
  ["waiting_for_capacity", "RUN_STATUS_WAITING_FOR_CAPACITY"],
  ["waiting", "RUN_STATUS_WAITING"],
]);

export function runStatusToWire(status: unknown): string {
  const wire =
    typeof status === "string" ? RUN_STATUS_TO_WIRE.get(status) : undefined;
  if (!wire) {
    throw new SchemaValidationError(
      `Invalid run status filter: ${String(status)}`,
      { validationErrors: [`no protobuf enum value for ${String(status)}`] }
    );
  }
  return wire;
}

// ============================================================================
// Push Request (serve.ts)
// ============================================================================

export const CompletedStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["completed", "failed", "timed_out"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const ResumeContextSchema = z.object({
  step_id: z.string(),
  type: z.enum(["sleep", "wait_for_event", "invoke_function", "invoke_function_async"]),
  data: z.unknown().optional(),
});

export const PushRequestEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown(),
  timestamp: z.string(),
  version: z.number().int().min(1).default(1),
  idempotency_key: z.string().optional(),
  source: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PushRequestSchema = z.object({
  run_id: z.string(),
  function_id: z.string(),
  attempt: z.number(),
  event: PushRequestEventSchema,
  steps: z
    .array(CompletedStepSchema)
    .nullish()
    .transform((v) => v ?? []),
  resume: ResumeContextSchema.optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Client API Responses (client.ts)
// ============================================================================

export const TriggerResponseSchema = z.object({
  runIds: z.array(z.string()).optional(),
  eventId: z.string(),
});

/**
 * One run outcome — proto `ironflow.v1.RunResult`.
 *
 * Shared by both synchronous RPCs: `TriggerSync` returns a repeated list of
 * these, `InvokeFunctionSync` returns exactly one. Kept under its original
 * name because it is public API.
 */
export const TriggerSyncResultItemSchema = z.object({
  runId: z.string(),
  functionId: z.string(),
  status: RunStatusWireSchema,
  output: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),
  // protojson omits zero-valued scalars, so an absent durationMs means 0 — not a
  // malformed response. The wait-timeout branch (handler.go, triggerSyncResultFromStore)
  // returns before DurationMs is set, so EVERY timed-out result omits it; a fast
  // sub-millisecond run does too. Without this default, validation throws and
  // RunWaitTimeoutError becomes unreachable.
  durationMs: z.number().default(0),
  waitTimedOut: z.boolean().default(false),
});

export const TriggerSyncResponseSchema = z.object({
  results: z.array(TriggerSyncResultItemSchema).optional(),
  eventId: z.string(),
});

/**
 * Response of `InvokeFunctionSync`.
 *
 * Exactly one `result`, and deliberately no `eventId`: the run id is the
 * correlator a direct-invoke caller needs, and the event the engine creates for
 * the invoke is a synthetic artifact. `result` is required — the server always
 * sets it, so an absent one is a contract violation and should surface as a
 * validation failure rather than an empty success.
 */
export const InvokeFunctionSyncResponseSchema = z.object({
  result: TriggerSyncResultItemSchema,
});

/**
 * A run as returned by the ConnectRPC run APIs.
 *
 * Connect marshals with protojson `EmitUnpopulated:false`, so a zero-valued
 * scalar is OMITTED from the response entirely — it is never sent as `0` or
 * `""`. Marking those keys required made zod throw on legitimate runs: a run on
 * its first attempt omits `attempt`, an invoke-created run omits `eventId`, and
 * a run whose id is the only populated field omits nearly everything. Every
 * scalar the server can leave at its zero value therefore carries a default
 * matching that zero value, NOT `.optional()` — callers still get the field
 * (#1919).
 */
export const RunResponseSchema = z.object({
  id: z.string(),
  functionId: z.string().default(""),
  eventId: z.string().default(""),
  executionMode: z.string().optional(),
  workerId: z.string().optional(),
  actorId: z.string().optional(),
  status: z.string().default(""),
  attempt: z.number().default(0),
  maxAttempts: z.number().default(0),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z
    .object({
      message: z.string().default(""),
      code: z.string().optional(),
    })
    .optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
});

export const ListRunsResponseSchema = z.object({
  runs: z.array(RunResponseSchema).optional(),
  nextCursor: z.string().optional(),
  totalCount: z.number().optional(),
});

export const RegisterFunctionResponseSchema = z.object({
  created: z.boolean().optional(),
});

export const HealthResponseSchema = z.object({
  status: z.string(),
});

export const ErrorResponseSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export const EmptyResponseSchema = z.object({});

// ============================================================================
// Consumer Group Responses
// ============================================================================

export const AckModeSchema = z.enum(["ACK_MODE_AUTO", "ACK_MODE_MANUAL", "ACK_MODE_UNSPECIFIED"]);

export const BackpressureModeSchema = z.enum([
  "BACKPRESSURE_MODE_DROP",
  "BACKPRESSURE_MODE_BLOCK",
  "BACKPRESSURE_MODE_BUFFER",
  "BACKPRESSURE_MODE_UNSPECIFIED",
]);

export const ConsumerGroupStatusSchema = z.enum([
  "CONSUMER_GROUP_STATUS_ACTIVE",
  "CONSUMER_GROUP_STATUS_PAUSED",
  "CONSUMER_GROUP_STATUS_DELETED",
  "CONSUMER_GROUP_STATUS_UNSPECIFIED",
]);

export const ConsumerGroupResponseSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
  pattern: z.string(),
  filterExpr: z.string().optional(),
  ackMode: AckModeSchema.optional(),
  backpressure: BackpressureModeSchema.optional(),
  maxInflight: z.number().optional(),
  maxRedeliveries: z.number().optional(),
  redeliverDelayMs: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: ConsumerGroupStatusSchema.optional(),
  memberCount: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const ListConsumerGroupsResponseSchema = z.object({
  groups: z.array(ConsumerGroupResponseSchema).optional(),
  nextCursor: z.string().optional(),
  totalCount: z.number().optional(),
});

// ============================================================================
// Worker Job Assignment (worker.ts)
// ============================================================================

export const JobCompletedStepSchema = z.object({
  step_id: z.string(),
  name: z.string(),
  output: z.unknown(),
});

export const JobEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown(),
  timestamp: z.string(),
  version: z.number().int().min(1).default(1),
  source: z.string().optional(),
  // Tolerate an explicit null on the wire (an absent-metadata event is
  // serialized server-side as JSON null, not omitted), normalizing it back to
  // undefined so consumers see the same shape as a genuinely-absent field. A
  // plain .optional() rejects null and would strand every run whose triggering
  // event carried no metadata (e.g. REST-emitted events).
  metadata: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((m) => m ?? undefined),
});

export const JobContextSchema = z.object({
  trace_id: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});

export const JobAssignmentSchema = z.object({
  job_id: z.string(),
  run_id: z.string(),
  function_id: z.string(),
  attempt: z.number(),
  event: JobEventSchema,
  completed_steps: z.array(JobCompletedStepSchema),
  // Sequence this execution's first step takes (#1670). Server-computed from
  // ALL persisted step rows, so a resumed run does not renumber over a sleeping
  // or failed row that completed_steps filters out. Absent on older servers.
  step_sequence_base: z.number().optional(),
  actor_id: z.string().optional(),
  context: JobContextSchema.optional(),
  // Execution fence (#1206, ADR 0037, T9). Present on capacity-mode assignments;
  // the worker acks with it before executing and echoes it on every update.
  // Absent for legacy / non-capacity assignments (default-off server).
  execution_seq: z.number().optional(),
  lease_token: z.string().optional(),
});

// ============================================================================
// WebSocket Messages (subscribe.ts)
// ============================================================================

export const EventMetadataSchema = z.object({
  timestamp: z.string(),
  sequence: z.number().optional(),
  sequenceExact: z.string().regex(/^\d+$/).optional(),
});

export const WSSubscriptionResultItemSchema = z.object({
  pattern: z.string(),
  status: z.enum(["ok", "error"]),
  subscriptionId: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export const WSSubscriptionResultSchema = z.object({
  type: z.literal("subscription_result"),
  results: z.array(WSSubscriptionResultItemSchema),
});

export const WSEventMessageSchema = z.object({
  type: z.literal("event"),
  subscriptionId: z.string(),
  topic: z.string(),
  data: z.unknown(),
  meta: EventMetadataSchema.optional(),
  eventId: z.string().optional(),
});

export const WSSubscriptionErrorSchema = z.object({
  type: z.literal("subscription_error"),
  subscriptionId: z.string(),
  code: z.string(),
  message: z.string(),
  retrying: z.boolean(),
});

export const WSErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const WSServerMessageSchema = z.discriminatedUnion("type", [
  WSSubscriptionResultSchema,
  WSEventMessageSchema,
  WSSubscriptionErrorSchema,
  WSErrorSchema,
]);

// ============================================================================
// Audit Schemas
// ============================================================================

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  functionId: z.string().min(1),
  stepId: z.string().optional(),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
});

// ============================================================================
// Time-Travel Debugging Schemas
// ============================================================================

export const TimeTravelStepSnapshotSchema = z.object({
  stepId: z.string(),
  name: z.string(),
  type: z.string(),
  sequence: z.number(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  originalOutput: z.unknown().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  injected: z.boolean(),
  patched: z.boolean(),
});

export const TimeTravelRunStateSnapshotSchema = z.object({
  runId: z.string(),
  functionId: z.string(),
  status: z.string(),
  input: z.unknown().optional(),
  steps: z.array(TimeTravelStepSnapshotSchema),
  timestamp: z.string(),
  createdAt: z.string().nullable().optional(),
});

export const TimeTravelTimelineEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  stepId: z.string().optional().default(""),
  stepName: z.string().optional().default(""),
  summary: z.string(),
  significant: z.boolean(),
  timestamp: z.string(),
});

// ============================================================================
// Type Exports (inferred from schemas)
// ============================================================================

export type ValidatedPushRequest = z.infer<typeof PushRequestSchema>;
export type ValidatedRunResponse = z.infer<typeof RunResponseSchema>;
export type ValidatedJobAssignment = z.infer<typeof JobAssignmentSchema>;
export type ValidatedWSServerMessage = z.infer<typeof WSServerMessageSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/** One `path: message` string per Zod issue — the shared shape for every SchemaValidationError. */
export function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/**
 * Safely parse JSON and validate against a schema
 * @throws {SchemaValidationError} if parsing or validation fails
 */
export function parseAndValidate<T>(
  schema: z.ZodType<T>,
  data: string,
  context: string
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new SchemaValidationError(`Invalid JSON in ${context}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = formatZodIssues(result.error.issues);
    throw new SchemaValidationError(
      `Validation failed in ${context}: ${issues.join(", ")}`,
      { validationErrors: issues }
    );
  }

  return result.data;
}

/**
 * Validate data against a schema (already parsed)
 * @throws {SchemaValidationError} if validation fails
 */
export function validate<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = formatZodIssues(result.error.issues);
    throw new SchemaValidationError(
      `Validation failed in ${context}: ${issues.join(", ")}`,
      { validationErrors: issues }
    );
  }

  return result.data;
}
