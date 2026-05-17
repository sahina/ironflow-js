/**
 * Zod Schemas for Runtime Validation
 *
 * These schemas validate incoming data from external sources (API responses,
 * WebSocket messages, webhook payloads) to ensure type safety at runtime.
 */

import { z } from "zod";

// ============================================================================
// Run Status
// ============================================================================

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
]);

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

export const TriggerSyncResultItemSchema = z.object({
  runId: z.string(),
  functionId: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),
  durationMs: z.number(),
});

export const TriggerSyncResponseSchema = z.object({
  results: z.array(TriggerSyncResultItemSchema).optional(),
  eventId: z.string(),
});

export const RunResponseSchema = z.object({
  id: z.string(),
  functionId: z.string(),
  eventId: z.string(),
  executionMode: z.string().optional(),
  workerId: z.string().optional(),
  actorId: z.string().optional(),
  status: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  concurrencyKey: z.string().optional(),
  priority: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  actor_id: z.string().optional(),
  context: JobContextSchema.optional(),
});

// ============================================================================
// WebSocket Messages (subscribe.ts)
// ============================================================================

export const EventMetadataSchema = z.object({
  timestamp: z.string(),
  sequence: z.number().optional(),
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

import { SchemaValidationError } from "./errors.js";

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
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new SchemaValidationError(
      `Validation failed in ${context}: ${issues}`,
      { validationErrors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }
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
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new SchemaValidationError(
      `Validation failed in ${context}: ${issues}`,
      { validationErrors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }
    );
  }

  return result.data;
}
