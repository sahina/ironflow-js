import { projectionStateFromWire, projectionStatusFromWire, rebuildJobFromWire } from "@ironflow/core";
import { stepInspectionFromWire } from "@ironflow/core";
import { functionListFromWire } from "@ironflow/core";
import { schemaFromWire, type SchemaWire } from "@ironflow/core";
import { connectHTTPError, ERROR_REASON_HEADER, waitResultFromWire, type WaitWireResult } from "@ironflow/core";
/**
 * Ironflow Node.js Client
 *
 * HTTP client for interacting with the Ironflow server.
 * Provides methods for registering functions, triggering events, and managing runs.
 */

import { getCurrentRunId } from "./internal/run-context.js";
import { encodeProtoBytes, decodeProtoBytes } from "./internal/proto-bytes.js";
import { mapRunResponse, type RunWireResponse } from "./internal/run-wire.js";
import {
  API_ENDPOINTS,
  DEFAULT_SERVER_URL,
  DEFAULT_TIMEOUTS,
  getServerUrl,
  InvokeFunctionSyncResponseSchema,
  IronflowError,
  RunWaitTimeoutError,
  RunFailedError,
  RunCancelledError,
  TriggerSyncResponseSchema,
  validate,
  AUTH_HELP,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
  ConflictError,
  ContendedError,
  ValidationError,
  type EmitSyncResult,
  type InvokeSyncOptions,
  type InvokeSyncResult,
  type TriggerBatchEvent,
  type StoredEvent,
  type ListEventsOptions,
  type ListEventsResult,
  type ListEventNamesOptions,
  type ListEventNamesResult,
  type RunStepsResult,
  type RunStreamsResult,
  type ListProjectionPartitionsOptions,
  type ListProjectionPartitionsResult,
  type ConsumerGroup,
  type ConsumerGroupConfig,
  type UpdateConsumerGroupInput,
  type RunStatus,
  type Trigger,
  type ExecutionMode,
  type RetryConfig,
  type ConcurrencyConfig,
  type DebounceConfig,
  type AppendEventInput,
  type AppendOptions,
  type AppendResult,
  type ReadStreamOptions,
  type StreamEvent,
  type StreamInfo,
  type StreamSnapshot,
  type CreateSQLProjectionInput,
  type QuerySQLProjectionOptions,
  type SQLProjectionQueryResult,
  type SQLProjectionValue,
  type PublishOptions,
  type PublishResult,
  type TopicInfo,
  type TopicStats,
  type ServerCapabilities,
  type APIKey,
  type APIKeyWithSecret,
  type CreateAPIKeyInput,
  type Organization,
  type CreateOrgInput,
  type UpdateOrgInput,
  type Role,
  type CreateRoleInput,
  type UpdateRoleInput,
  type Policy,
  type CreatePolicyInput,
  type UpdatePolicyInput,
  type ProjectionStateResult,
  type GetProjectionOptions,
  type ProjectionStatusInfo,
  type RebuildJob,
  type WaitResult,
  type TimeTravelRunState,
  type TimeTravelTimelineEvent,
  type TimeTravelStepOutput,
  type AuditTrailEntry,
  type AuditEvent,
  type AuditTrailResult,
  type ListAuditEventsOptions,
  type Secret,
  type SecretListEntry,
  type PatchSecretInput,
  type StreamListEntry,
  type EntityHistoryEntry,
  type Project,
  type Environment,
  type EventSchema,
  type RegisterSchemaInput,
  type TestUpcastInput,
  type UpcastResult,
  type WebhookSource,
  type CreateWebhookSourceInput,
  type UpdateWebhookSourceInput,
  type RotateWebhookSecretInput,
  type DisableWebhookSignatureVerificationInput,
  webhookVerifyConfigToWire,
  webhookGraceToWire,
  webhookSourceFromWire,
  webhookDeliveryFromWire,
  type WebhookDelivery,
  type ListWebhookDeliveriesOptions,
  type User,
  type CreateUserInput,
  type UpdateUserInput,
  type ChangePasswordInput,
  type Tenant,
  type ProvisionTenantInput,
  type ProvisionTenantResult,
  type ListAgentToolsResult,
  type FunctionStatus,
  type RegisteredFunction,
  type FunctionHistoryEntry,
  type ListFunctionHistoryOptions,
  type ListFunctionHistoryResult,
  registeredFunctionFromWire,
  functionHistoryEntryFromWire,
  storedEventFromWire,
  runStepFromWire,
  consumerGroupFromWire,
  runStatusToWire,
} from "@ironflow/core";
import { KVClient } from "./kv.js";
import { CommandDedup, type CommandDedupOptions } from "./command-dedup.js";
import { ConfigClient } from "./config-client.js";
import type { OnErrorHandler, ErrorContext } from "./types.js";

function auditEventFromWire(raw: Record<string, unknown>): AuditEvent {
  return {
    id: String(raw.id ?? ""),
    runId: String(raw.run_id ?? raw.runId ?? ""),
    functionId: String(raw.function_id ?? raw.functionId ?? ""),
    stepId: (raw.step_id ?? raw.stepId) as string | undefined,
    eventType: String(raw.event_type ?? raw.eventType ?? ""),
    payload: (raw.payload as Record<string, unknown>) ?? {},
    metadata: raw.metadata as Record<string, string> | undefined,
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
  };
}

function visibleAgentToolFromWire(raw: Record<string, unknown>) {
  return {
    qualifiedName: String(raw.qualifiedName ?? raw.qualified_name ?? ""),
    description: String(raw.description ?? ""),
    inputSchemaJson: String(raw.inputSchemaJson ?? raw.input_schema_json ?? ""),
    requiredScopes: (raw.requiredScopes ?? raw.required_scopes ?? []) as string[],
  };
}

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Configuration for the Ironflow client
 */
export interface IronflowClientConfig {
  /** Server URL (default: http://localhost:9123 or IRONFLOW_SERVER_URL env var) */
  serverUrl?: string;
  /** API key for authentication. Empty or unset falls back to the IRONFLOW_API_KEY env var; optional for local dev. */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Global error handler called on every client error (fires before re-throw) */
  onError?: OnErrorHandler;
}

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Function registration request
 */
export interface RegisterFunctionRequest {
  /** Unique function identifier */
  id: string;
  /** Display name */
  name?: string;
  /** Description */
  description?: string;
  /** Event triggers */
  triggers?: Trigger[];
  /** Retry configuration */
  retry?: RetryConfig;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Concurrency configuration */
  concurrency?: ConcurrencyConfig;
  /** Debounce configuration — collapse rapid events (issue #545) */
  debounce?: DebounceConfig;
  /** Preferred execution mode */
  preferredMode?: ExecutionMode;
  /** Endpoint URL for push mode */
  endpointUrl?: string;
  /** Actor key for sticky routing */
  actorKey?: string;
  /** Cancel-on-event specs (issue #546 P3 / #572). */
  cancelOn?: { event: string; match: string }[];
}

/**
 * Result from registering a function
 */
export interface RegisterFunctionResult {
  /** Whether the function was newly created (vs updated) */
  created: boolean;
}

/**
 * Result from emitting an event
 */
export interface EmitResult {
  /** IDs of runs created by this event */
  runIds: string[];
  /** ID of the stored event */
  eventId: string;
}

/**
 * Options for emitting an event
 */
export interface EmitOptions {
  /** Event schema version (default 1) */
  version?: number;
  /** Idempotency key to prevent duplicate processing */
  idempotencyKey?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Run information
 */
export interface Run {
  /** Run ID */
  id: string;
  /** Function ID */
  functionId: string;
  /** Event ID that triggered this run */
  eventId: string;
  /** Current status */
  status: RunStatus;
  /** Current attempt number */
  attempt: number;
  /** Maximum attempts allowed */
  maxAttempts: number;
  /** Input data */
  input?: unknown;
  /** Output data (if completed) */
  output?: unknown;
  /** Error information (if failed) */
  error?: { message: string; code: string };
  /** When the run started */
  startedAt?: string;
  /** When the run ended */
  endedAt?: string;
  /** When the run was created */
  createdAt: string;
  /** When the run was last updated */
  updatedAt: string;
}

/**
 * Options for listing runs
 */
export interface ListRunsOptions {
  /** Filter by function ID */
  functionId?: string;
  /** Filter by status */
  status?: RunStatus;
  /** Maximum number of results */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

/**
 * Result from listing runs
 */
export interface ListRunsResult {
  /** List of runs */
  runs: Run[];
  /** Cursor for next page */
  nextCursor?: string;
  /** Total count of matching runs */
  totalCount: number;
}

// ============================================================================
// Client Implementation
// ============================================================================

/**
 * Ironflow client for server-side operations
 *
 * @example
 * ```typescript
 * import { createClient } from "@ironflow/node";
 *
 * const client = createClient({
 *   serverUrl: "http://localhost:9123",
 * });
 *
 * // Register a function
 * await client.registerFunction({
 *   id: "my-function",
 *   name: "My Function",
 *   triggers: [{ event: "my.event" }],
 *   endpointUrl: "http://localhost:3000/api/ironflow",
 *   preferredMode: "push",
 * });
 *
 * // Emit an event
 * const result = await client.emit("my.event", { data: "value" });
 * console.log("Created runs:", result.runIds);
 * ```
 */
export class IronflowClient {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly onErrorHandler?: OnErrorHandler;

  constructor(config: IronflowClientConfig = {}) {
    this.serverUrl = config.serverUrl || getServerUrl() || DEFAULT_SERVER_URL;
    // `||`, not `??`: an empty string means "not configured" here, matching Go's
    // `if apiKey == "" { apiKey = GetAPIKey() }`. Without it, the common
    // `apiKey: process.env.SOMETHING ?? ""` spelling stays unauthenticated with a
    // perfectly good key in the environment — the bug this fallback exists to fix.
    this.apiKey = config.apiKey || process.env.IRONFLOW_API_KEY;
    this.timeout = config.timeout ?? 30000;
    this.onErrorHandler = config.onError;
  }

  /**
   * Register a function with the Ironflow server
   */
  async registerFunction(
    request: RegisterFunctionRequest
  ): Promise<RegisterFunctionResult> {
    const body: Record<string, unknown> = {
      id: request.id,
    };

    if (request.name) body.name = request.name;
    if (request.description) body.description = request.description;
    if (request.triggers) body.triggers = request.triggers;
    if (request.retry) body.retry = request.retry;
    if (request.timeoutMs) body.timeoutMs = request.timeoutMs;
    if (request.concurrency) body.concurrency = request.concurrency;
    if (request.debounce) {
      // Server expects snake_case period_ms / max_wait_ms;
      // SDK uses camelCase for parity with the rest of the TS surface.
      body.debounce = {
        period_ms: request.debounce.periodMs,
        key: request.debounce.key ?? "",
        ...(request.debounce.maxWaitMs != null
          ? { max_wait_ms: request.debounce.maxWaitMs }
          : {}),
      };
    }
    if (request.preferredMode) body.preferredMode = request.preferredMode;
    if (request.endpointUrl) body.endpointUrl = request.endpointUrl;
    if (request.actorKey) body.actorKey = request.actorKey;
    if (request.cancelOn?.length) body.cancelOn = request.cancelOn;

    const response = await this.request<{ created: boolean }>(

      API_ENDPOINTS.REGISTER_FUNCTION,
      body,
      "registerFunction"
    );

    return { created: response.created };
  }

  /** Get a registered function by ID. */
  async getFunction(functionId: string): Promise<RegisteredFunction> {
    const response = await this.request<Record<string, unknown>>(
      "/ironflow.v1.IronflowService/GetFunction",
      { id: functionId },
      "getFunction"
    );
    return registeredFunctionFromWire(response);
  }

  /** Change a function's lifecycle status. */
  async updateFunctionStatus(
    functionId: string,
    status: Exclude<FunctionStatus, "unspecified">
  ): Promise<RegisteredFunction> {
    const response = await this.request<Record<string, unknown>>(
      "/ironflow.v1.IronflowService/UpdateFunctionStatus",
      {
        id: functionId,
        status: `FUNCTION_STATUS_${status.toUpperCase()}`,
      },
      "updateFunctionStatus"
    );
    return registeredFunctionFromWire(response);
  }

  /** Permanently delete a registered function. */
  async deleteFunction(functionId: string): Promise<void> {
    await this.request<Record<string, never>>(
      "/ironflow.v1.IronflowService/DeleteFunction",
      { id: functionId },
      "deleteFunction"
    );
  }

  /** List immutable configuration snapshots, newest first. */
  async listFunctionHistory(
    functionId: string,
    options: ListFunctionHistoryOptions = {}
  ): Promise<ListFunctionHistoryResult> {
    const response = await this.request<{
      entries?: Record<string, unknown>[];
      hasMore?: boolean;
    }>(
      "/ironflow.v1.IronflowService/ListFunctionHistory",
      {
        functionId,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.fromVersion !== undefined
          ? { fromVersion: String(options.fromVersion) }
          : {}),
      },
      "listFunctionHistory"
    );
    return {
      entries: (response.entries ?? []).map(functionHistoryEntryFromWire),
      hasMore: response.hasMore ?? false,
    };
  }

  /** Get one historical configuration snapshot by entity version. */
  async getFunctionAtVersion(
    functionId: string,
    version: number
  ): Promise<FunctionHistoryEntry> {
    const response = await this.request<{
      entry?: Record<string, unknown>;
    }>(
      "/ironflow.v1.IronflowService/GetFunctionAtVersion",
      { functionId, version: String(version) },
      "getFunctionAtVersion"
    );
    return functionHistoryEntryFromWire(response.entry);
  }

  /** Restore a function's configuration from a historical version. */
  async rollbackFunction(
    functionId: string,
    version: number,
    changeReason?: string
  ): Promise<RegisteredFunction> {
    const response = await this.request<{
      function?: Record<string, unknown>;
    }>(
      "/ironflow.v1.IronflowService/RollbackFunction",
      {
        functionId,
        version: String(version),
        ...(changeReason ? { changeReason } : {}),
      },
      "rollbackFunction"
    );
    return registeredFunctionFromWire(response.function);
  }

  /**
   * Emit an event to trigger workflows
   *
   * @example
   * ```typescript
   * const result = await client.emit("order.placed", {
   *   orderId: "123",
   *   total: 99.99,
   * });
   * console.log("Created runs:", result.runIds);
   * ```
   */
  async emit(
    eventName: string,
    data: unknown,
    options?: EmitOptions
  ): Promise<EmitResult> {
    const body: Record<string, unknown> = {
      event: eventName,
      data,
    };

    // `!== undefined`: 0 is unset, but a negative must reach the server so
    // it reports the mistake instead of the client emitting at version 1.
    if (options?.version !== undefined) body.version = options.version;
    if (options?.idempotencyKey) body.idempotencyKey = options.idempotencyKey;
    if (options?.metadata) body.metadata = options.metadata;

    const response = await this.request<{ runIds: string[]; eventId: string }>(
      API_ENDPOINTS.TRIGGER,
      body,
      "emit"
    );

    return {
      runIds: response.runIds || [],
      eventId: response.eventId,
    };
  }

  /** Trigger multiple events in one request. */
  async triggerBatch(events: TriggerBatchEvent[]): Promise<EmitResult[]> {
    const response = await this.request<{
      results?: Array<{ runIds?: string[]; eventId: string }>;
    }>(
      "/ironflow.v1.IronflowService/TriggerBatch",
      {
        events: events.map((event) => ({
          event: event.event,
          data: event.data,
          ...(event.version !== undefined ? { version: event.version } : {}),
          ...(event.idempotencyKey
            ? { idempotencyKey: event.idempotencyKey }
            : {}),
          ...(event.metadata ? { metadata: event.metadata } : {}),
        })),
      },
      "triggerBatch"
    );
    return (response.results ?? []).map((result) => ({
      runIds: result.runIds ?? [],
      eventId: result.eventId,
    }));
  }

  /** Read a keyset-paginated page from the event log. */
  async listEvents(options: ListEventsOptions = {}): Promise<ListEventsResult> {
    const query = new URLSearchParams();
    if (options.name) query.set("name", options.name);
    if (options.names?.length) query.set("names", options.names.join(","));
    if (options.sources?.length) query.set("source", options.sources.join(","));
    if (options.search) query.set("search", options.search);
    if (options.since) query.set("since", options.since);
    if (options.until) query.set("until", options.until);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.before) query.set("before", options.before);
    const suffix = query.size ? `?${query}` : "";
    const response = await this.restRequest<{
      events?: Record<string, unknown>[];
      count?: number;
      limit?: number;
      next_cursor?: string;
      prev_cursor?: string;
      has_next?: boolean;
      has_prev?: boolean;
      approx_total?: number;
      approx_total_capped?: boolean;
    }>("GET", `/api/v1/events${suffix}`, undefined, "listEvents");
    return {
      events: (response.events ?? []).map(storedEventFromWire),
      count: response.count ?? 0,
      limit: response.limit ?? options.limit ?? 20,
      nextCursor: response.next_cursor,
      prevCursor: response.prev_cursor,
      hasNext: response.has_next ?? false,
      hasPrev: response.has_prev ?? false,
      approxTotal: response.approx_total,
      approxTotalCapped: response.approx_total_capped ?? false,
    };
  }

  /** Get one persisted event by ID. */
  async getEvent(eventId: string): Promise<StoredEvent> {
    const response = await this.restRequest<Record<string, unknown>>(
      "GET",
      `/api/v1/events/${encodeURIComponent(eventId)}`,
      undefined,
      "getEvent"
    );
    return storedEventFromWire(response);
  }

  /** List event names and counts for filter UIs. */
  async listEventNames(
    options: ListEventNamesOptions = {}
  ): Promise<ListEventNamesResult> {
    const query = new URLSearchParams();
    if (options.sources?.length) query.set("source", options.sources.join(","));
    if (options.since) query.set("since", options.since);
    if (options.until) query.set("until", options.until);
    const suffix = query.size ? `?${query}` : "";
    const response = await this.restRequest<{
      names?: Array<{ name: string; count: number }>;
      scanned?: number;
      truncated?: boolean;
      scan_cap?: number;
    }>("GET", `/api/v1/events/names${suffix}`, undefined, "listEventNames");
    return {
      names: response.names ?? [],
      scanned: response.scanned ?? 0,
      truncated: response.truncated ?? false,
      scanCap: response.scan_cap ?? 0,
    };
  }

  /**
   * Emit an event synchronously — waits for every triggered run to finish and
   * returns one result per run.
   *
   * An event can match several triggers, so this returns an array: every matched
   * run is reported, in dispatch order. An event that matches nothing returns
   * `[]` (the server answers with an empty result list — `handler.go:810-815`).
   *
   * Per-run outcomes are never thrown — inspect `status`, `error` and
   * `waitTimedOut` on each element. Transport, protocol and validation failures
   * still throw. Use `invoke()` when you target exactly one function and want
   * failures raised as exceptions.
   *
   * @example
   * ```typescript
   * const results = await client.emitSync("order.placed", { orderId: "123" });
   * for (const r of results) {
   *   if (r.error) console.error(r.functionId, r.error.message);
   *   else console.log(r.functionId, r.output);
   * }
   * ```
   */
  async emitSync(
    eventName: string,
    data: unknown,
    options?: { timeout?: number; idempotencyKey?: string; version?: number }
  ): Promise<EmitSyncResult[]> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUTS.TRIGGER_SYNC;
    // ponytail: ceiling ~295s. Node's built-in fetch enforces its own ~300s
    // undici headers timeout that no AbortController overrides (measured:
    // UND_ERR_HEADERS_TIMEOUT at 301524ms on node v24.15.0). A larger budget
    // kills the socket, which the server reads as an abandoned caller and
    // cancels the run. Fix, if a caller ever needs it: a custom undici
    // dispatcher — a new dependency, not worth it for a synchronous call.
    const body: Record<string, unknown> = {
      event: eventName,
      data,
      timeout_ms: timeout,
    };
    if (options?.idempotencyKey) {
      body.idempotency_key = options.idempotencyKey;
    }
    // `!== undefined`, not truthiness: only an absent option is omitted. 0 and
    // negatives are both forwarded -- 0 because the server coerces it to 1
    // anyway, a negative so the server can answer with the reason instead of
    // the client silently emitting at version 1.
    if (options?.version !== undefined) {
      body.version = options.version;
    }

    const raw = await this.request<unknown>(
      API_ENDPOINTS.TRIGGER_SYNC,
      body,
      "emitSync",
      // The wait budget travels in the body; the transport deadline stays
      // strictly longer. Aborting the request is how a caller says "I am gone",
      // which makes `waitTimedOut` unobservable. Not clamped to `this.timeout`
      // on purpose — a short client timeout must not shorten a sync wait.
      timeout + DEFAULT_TIMEOUTS.SYNC_TRANSPORT_HEADROOM
    );

    const response = validate(
      TriggerSyncResponseSchema,
      raw,
      "TriggerSync response"
    );

    return (response.results ?? []).map((result) => ({
      runId: result.runId,
      functionId: result.functionId,
      status: result.status,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
      waitTimedOut: result.waitTimedOut,
    }));
  }

  /**
   * Invoke one workflow function by ID and wait for its run to finish.
   *
   * Unlike `emitSync()`, this targets a function directly, so there is exactly
   * one run — and an unambiguous outcome to throw. Raises `RunFailedError`,
   * `RunCancelledError`, or `RunWaitTimeoutError` (the wait budget expired while
   * the durable run kept going; poll `getRun(runId)` for its outcome).
   *
   * @example
   * ```typescript
   * const result = await client.invoke("process-order", {
   *   data: { orderId: "123" },
   * });
   * console.log(result.output);
   * ```
   */
  async invoke<TInput = unknown>(
    functionId: string,
    options: InvokeSyncOptions<TInput>
  ): Promise<InvokeSyncResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUTS.INVOKE_FUNCTION_SYNC;
    // Same ~295s ceiling as emitSync, and it costs more here: the socket dying
    // cancels the run outright (Q19).
    const body: Record<string, unknown> = {
      function_id: functionId,
      data: options.data,
      timeout_ms: timeout,
    };
    if (options.idempotencyKey) {
      body.idempotency_key = options.idempotencyKey;
    }
    if (options.metadata) {
      body.metadata = options.metadata;
    }

    const raw = await this.request<unknown>(
      API_ENDPOINTS.INVOKE_FUNCTION_SYNC,
      body,
      "invoke",
      // Same split as emitSync, and it matters more here: InvokeFunctionSync
      // ties the run's lifetime to the request context, so a transport abort
      // cancels the run server-side.
      timeout + DEFAULT_TIMEOUTS.SYNC_TRANSPORT_HEADROOM
    );

    const { result } = validate(
      InvokeFunctionSyncResponseSchema,
      raw,
      "InvokeFunctionSync response"
    );

    if (result.waitTimedOut) {
      throw new RunWaitTimeoutError(
        result.runId,
        result.functionId,
        result.status,
        timeout
      );
    }
    if (result.status === "failed") {
      throw new RunFailedError(result.runId, result.output, result.error?.message);
    }
    if (result.status === "cancelled") {
      throw new RunCancelledError(result.runId);
    }

    return {
      runId: result.runId,
      functionId: result.functionId,
      status: result.status,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    };
  }

  /**
   * Publish a message to a developer pub/sub topic.
   * Unlike emit(), this does NOT trigger workflow functions.
   *
   * @example
   * ```typescript
   * const result = await client.publish("notifications", {
   *   userId: "123",
   *   message: "Hello!",
   * });
   * console.log("Published:", result.eventId, result.sequence);
   * ```
   */
  async publish(
    topic: string,
    data: unknown,
    options?: PublishOptions
  ): Promise<PublishResult> {
    const body: Record<string, unknown> = {
      topic,
      data: data ?? {},
    };
    if (options?.idempotencyKey) {
      body.idempotencyKey = options.idempotencyKey;
    }

    const response = await this.request<{ eventId: string; sequence: string }>(
      "/ironflow.v1.PubSubService/Publish",
      body,
      "publish"
    );

    return {
      eventId: response.eventId,
      sequence: parseInt(response.sequence, 10) || 0,
    };
  }

  /**
   * List all active developer pub/sub topics.
   *
   * @example
   * ```typescript
   * const topics = await client.listTopics();
   * for (const t of topics) {
   *   console.log(t.name, t.messageCount);
   * }
   * ```
   */
  async listTopics(): Promise<TopicInfo[]> {
    const response = await this.request<{
      topics?: Array<Record<string, unknown>>;
    }>("/ironflow.v1.PubSubService/ListTopics", {}, "listTopics");

    return (response.topics ?? []).map((t) => ({
      name: String(t.name ?? ""),
      messageCount: Number(t.messageCount ?? 0),
      consumerCount: Number(t.consumerCount ?? 0),
      firstMessageAt: t.firstMessageAt ? String(t.firstMessageAt) : undefined,
      lastMessageAt: t.lastMessageAt ? String(t.lastMessageAt) : undefined,
    }));
  }

  /**
   * Get detailed statistics for a topic.
   *
   * @example
   * ```typescript
   * const stats = await client.getTopicStats("notifications");
   * console.log("Messages:", stats.messageCount, "Lag:", stats.lag);
   * ```
   */
  async getTopicStats(topic: string): Promise<TopicStats> {
    const response = await this.request<Record<string, unknown>>(
      "/ironflow.v1.PubSubService/GetTopicStats",
      { topic },
      "getTopicStats"
    );

    return {
      name: String(response.name ?? ""),
      messageCount: Number(response.messageCount ?? 0),
      consumerCount: Number(response.consumerCount ?? 0),
      lag: Number(response.lag ?? 0),
      firstSeq: Number(response.firstSeq ?? 0),
      lastSeq: Number(response.lastSeq ?? 0),
    };
  }

  /** Return the transports and optional features exposed by this server. */
  async getCapabilities(): Promise<ServerCapabilities> {
    const response = await this.restRequest<{
      transports?: string[];
      features?: string[];
      version?: string;
      auth_required?: boolean;
    }>("GET", "/api/v1/capabilities", undefined, "getCapabilities");
    return {
      transports: response.transports ?? [],
      features: response.features ?? [],
      version: response.version ?? "",
      authRequired: response.auth_required,
    };
  }

  /** Consumer-group lifecycle management. */
  readonly consumerGroups = {
    create: async (config: ConsumerGroupConfig): Promise<ConsumerGroup> => {
      const response = await this.request<Record<string, unknown>>(
        "/ironflow.v1.PubSubService/CreateConsumerGroup",
        {
          name: config.name,
          pattern: config.pattern,
          namespace: config.namespace ?? "default",
          ...(config.filterExpr !== undefined ? { filterExpr: config.filterExpr } : {}),
          ...(config.ackMode ? { ackMode: `ACK_MODE_${config.ackMode.toUpperCase()}` } : {}),
          ...(config.backpressure
            ? { backpressure: `BACKPRESSURE_MODE_${config.backpressure.toUpperCase()}` }
            : {}),
          ...(config.maxInflight !== undefined ? { maxInflight: config.maxInflight } : {}),
          ...(config.maxRedeliveries !== undefined
            ? { maxRedeliveries: config.maxRedeliveries }
            : {}),
          ...(config.redeliverDelayMs !== undefined
            ? { redeliverDelayMs: config.redeliverDelayMs }
            : {}),
          ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
        },
        "consumerGroups.create"
      );
      return consumerGroupFromWire(response);
    },
    get: async (name: string, namespace = "default"): Promise<ConsumerGroup> => {
      const response = await this.request<Record<string, unknown>>(
        "/ironflow.v1.PubSubService/GetConsumerGroup",
        { name, namespace },
        "consumerGroups.get"
      );
      return consumerGroupFromWire(response);
    },
    list: async (namespace?: string): Promise<ConsumerGroup[]> => {
      const groups: ConsumerGroup[] = [];
      let cursor: string | undefined;
      do {
        const response = await this.request<{
          groups?: Record<string, unknown>[];
          nextCursor?: string;
          next_cursor?: string;
        }>(
          "/ironflow.v1.PubSubService/ListConsumerGroups",
          {
            ...(namespace ? { namespace } : {}),
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          "consumerGroups.list"
        );
        groups.push(...(response.groups ?? []).map(consumerGroupFromWire));
        cursor = response.nextCursor || response.next_cursor || undefined;
      } while (cursor);
      return groups;
    },
    update: async (
      name: string,
      input: UpdateConsumerGroupInput,
      namespace = "default"
    ): Promise<ConsumerGroup> => {
      const group: Record<string, unknown> = { name, namespace };
      const paths: string[] = [];
      const set = (path: string, value: unknown) => {
        if (value !== undefined) {
          group[path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
          paths.push(path);
        }
      };
      set("pattern", input.pattern);
      set("filter_expr", input.filterExpr);
      set("ack_mode", input.ackMode ? `ACK_MODE_${input.ackMode.toUpperCase()}` : undefined);
      set(
        "backpressure",
        input.backpressure
          ? `BACKPRESSURE_MODE_${input.backpressure.toUpperCase()}`
          : undefined
      );
      set("max_inflight", input.maxInflight);
      set("max_redeliveries", input.maxRedeliveries);
      set("redeliver_delay_ms", input.redeliverDelayMs);
      set("metadata", input.metadata);
      set(
        "status",
        input.status
          ? `CONSUMER_GROUP_STATUS_${input.status.toUpperCase()}`
          : undefined
      );
      if (paths.length === 0) {
        throw new ValidationError("Consumer group update requires at least one field");
      }
      const response = await this.request<Record<string, unknown>>(
        "/ironflow.v1.PubSubService/UpdateConsumerGroup",
        { group, updateMask: { paths } },
        "consumerGroups.update"
      );
      return consumerGroupFromWire(response);
    },
    delete: async (name: string, namespace = "default"): Promise<void> => {
      await this.request<Record<string, never>>(
        "/ironflow.v1.PubSubService/DeleteConsumerGroup",
        { name, namespace },
        "consumerGroups.delete"
      );
    },
  };

  /** Agent tools visible to the current API key. */
  readonly agentTools = {
    list: async (cursor?: string): Promise<ListAgentToolsResult> => {
      const response = await this.request<{
        tools?: Record<string, unknown>[];
        nextCursor?: string;
        next_cursor?: string;
      }>(
        "/ironflow.v1.AgentToolsService/ListTools",
        { cursor: cursor ?? "" },
        "agentTools.list"
      );
      return {
        tools: (response.tools ?? []).map(visibleAgentToolFromWire),
        nextCursor: response.nextCursor || response.next_cursor || undefined,
      };
    },
  };

  /**
   * Get a run by ID
   */
  async getRun(runId: string): Promise<Run> {
    const response = await this.request<RunWireResponse>(
      API_ENDPOINTS.GET_RUN,
      { id: runId },
      "getRun"
    );
    return mapRunResponse(response);
  }

  /** Get the durable steps recorded for a run. */
  async getRunSteps(runId: string): Promise<RunStepsResult> {
    const response = await this.request<{ steps?: Record<string, unknown>[] }>(
      "/ironflow.v1.IronflowService/GetRunSteps",
      { runId },
      "getRunSteps",
      undefined,
      true,
    );
    const steps = (response.steps ?? []).map((raw) =>
      runStepFromWire(stepInspectionFromWire(raw)),
    );
    return { steps, count: steps.length };
  }

  /** Get the entity stream IDs touched by a run. */
  async getRunStreams(runId: string): Promise<RunStreamsResult> {
    const response = await this.restRequest<{ entity_ids?: string[] }>(
      "GET",
      `/api/v1/runs/${encodeURIComponent(runId)}/streams`,
      undefined,
      "getRunStreams"
    );
    return { entityIds: response.entity_ids ?? [] };
  }

  /**
   * List runs with optional filtering
   */
  async listRuns(options?: ListRunsOptions): Promise<ListRunsResult> {
    const body: Record<string, unknown> = {};

    if (options?.functionId) body.functionId = options.functionId;
    // Protobuf enum field: only the canonical RUN_STATUS_* name survives.
    if (options?.status) body.status = runStatusToWire(options.status);
    if (options?.limit) body.limit = options.limit;
    if (options?.cursor) body.cursor = options.cursor;

    const response = await this.request<{
      runs?: RunWireResponse[];
      nextCursor?: string;
      totalCount?: number;
    }>(API_ENDPOINTS.LIST_RUNS, body, "listRuns");

    return {
      runs: (response.runs ?? []).map(mapRunResponse),
      nextCursor: response.nextCursor ?? "",
      totalCount: response.totalCount ?? 0,
    };
  }

  /**
   * Cancel a running workflow
   */
  async cancelRun(runId: string, reason?: string): Promise<Run> {
    const response = await this.request<RunWireResponse>(
      API_ENDPOINTS.CANCEL_RUN,
      { id: runId, reason: reason || "" },
      "cancelRun"
    );
    return mapRunResponse(response);
  }

  /**
   * Health check
   */
  async health(): Promise<string> {
    const response = await this.request<{ status: string }>(
      API_ENDPOINTS.HEALTH,
      {},
      "health"
    );
    return response.status;
  }

  /**
   * Entity stream operations
   *
   * @example
   * ```typescript
   * // Append an event to a stream
   * const result = await client.streams.append("order-123", {
   *   name: "order.created",
   *   data: { total: 100 },
   *   entityType: "order",
   * });
   *
   * // Read events from a stream
   * const { events } = await client.streams.read("order-123", { limit: 10 });
   *
   * // Get stream info
   * const info = await client.streams.getInfo("order-123");
   * ```
   */
  streams = {
    /**
     * Append an event to an entity stream
     */
    append: async (
      entityId: string,
      input: AppendEventInput,
      options?: AppendOptions
    ): Promise<AppendResult> => {
      const body: Record<string, unknown> = {
        entity_id: entityId,
        entity_type: input.entityType,
        event_name: input.name,
        data: input.data,
        expected_version: options?.expectedVersion ?? -1,
        idempotency_key: options?.idempotencyKey ?? "",
        version: options?.version ?? 1,
      };
      if (options?.metadata !== undefined) {
        body.metadata = options.metadata;
      }
      const response = await this.request<{
        entityVersion: string;
        eventId: string;
      }>("/ironflow.v1.EntityStreamService/AppendEvent", body, "streams.append");
      return {
        entityVersion: Number(response.entityVersion ?? 0),
        eventId: response.eventId,
      };
    },

    /**
     * Read events from an entity stream
     */
    read: async (
      entityId: string,
      options?: ReadStreamOptions
    ): Promise<{ events: StreamEvent[]; totalCount: number }> => {
      const response = await this.request<{
        events?: Array<{
          id: string;
          name: string;
          data?: Record<string, unknown>;
          entityVersion: string;
          version: number;
          timestamp: string;
          source?: string;
          metadata?: Record<string, unknown>;
        }>;
        totalCount?: number;
      }>("/ironflow.v1.EntityStreamService/ReadStream", {
        entity_id: entityId,
        from_version: options?.fromVersion ?? 0,
        limit: options?.limit ?? 0,
        direction: options?.direction ?? "forward",
      }, "streams.read");
      return {
        events: (response.events ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          data: e.data ?? {},
          entityVersion: Number(e.entityVersion ?? 0),
          version: e.version,
          timestamp: e.timestamp,
          source: e.source,
          metadata: e.metadata,
        })),
        totalCount: response.totalCount ?? 0,
      };
    },

    /**
     * Get information about an entity stream.
     *
     * Returns `null` if no events have been written to this stream yet — safe to
     * pass `expectedVersion: 0` to `append()` in that case to create the first event.
     *
     * @example
     * ```typescript
     * const info = await client.streams.getInfo("order-123");
     * await client.streams.append("order-123", event, {
     *   expectedVersion: info ? info.version : 0,
     * });
     * ```
     */
    getInfo: async (entityId: string): Promise<StreamInfo | null> => {
      try {
        const response = await this.request<{
          entityId: string;
          entityType: string;
          version: string;
          eventCount: string;
          createdAt: string;
          updatedAt: string;
        }>("/ironflow.v1.EntityStreamService/GetStreamInfo", {
          entity_id: entityId,
        }, "streams.getInfo");
        return {
          entityId: response.entityId,
          entityType: response.entityType,
          version: Number(response.version ?? 0),
          eventCount: Number(response.eventCount ?? 0),
          createdAt: response.createdAt,
          updatedAt: response.updatedAt,
        };
      } catch (err) {
        if (err instanceof IronflowError && err.message === "stream not found") {
          return null;
        }
        throw err;
      }
    },

    /**
     * Create a snapshot of the materialized state at a specific stream version.
     * Use snapshots to speed up state reconstruction for long-lived entity streams.
     */
    createSnapshot: async (
      entityId: string,
      input: {
        entityType: string;
        entityVersion: number;
        state: Record<string, unknown>;
      }
    ): Promise<{ snapshotId: string }> => {
      const response = await this.request<{
        snapshotId: string;
      }>("/ironflow.v1.EntityStreamService/CreateSnapshot", {
        entity_id: entityId,
        entity_type: input.entityType,
        entity_version: input.entityVersion,
        state: input.state,
      }, "streams.createSnapshot");
      return { snapshotId: response.snapshotId };
    },

    /**
     * Get the latest snapshot at or before a given version.
     * Returns the snapshot closest to the requested version without exceeding it.
     */
    getSnapshot: async (
      entityId: string,
      options?: { beforeVersion?: number }
    ): Promise<StreamSnapshot> => {
      const response = await this.request<{
        snapshotId: string;
        entityId: string;
        entityType: string;
        entityVersion: string;
        state: Record<string, unknown>;
        createdAt: string;
      }>("/ironflow.v1.EntityStreamService/GetSnapshot", {
        entity_id: entityId,
        before_version: options?.beforeVersion ?? 0,
      }, "streams.getSnapshot");
      return {
        snapshotId: response.snapshotId,
        entityId: response.entityId,
        entityType: response.entityType,
        entityVersion: Number(response.entityVersion ?? 0),
        state: response.state,
        createdAt: response.createdAt,
      };
    },

    /**
     * List all entity streams.
     */
    listStreams: async (): Promise<StreamListEntry[]> => {
      const response = await this.request<{
        streams?: Array<Record<string, unknown>>;
      }>(
        "/ironflow.v1.EntityStreamService/ListStreams",
        {},
        "streams.listStreams",
        undefined,
        true,
      );
      return (response.streams ?? []).map((stream) => ({
        entityId: String(stream.entityId ?? ""),
        entityType: String(stream.entityType ?? ""),
        version: Number(stream.version ?? 0),
        eventCount: Number(stream.eventCount ?? 0),
        lastEventAt: String(stream.updatedAt ?? ""),
      }));
    },

    /**
     * Get the full event history for an entity.
     */
    getEntityHistory: async (
      entityId: string,
    ): Promise<EntityHistoryEntry[]> => {
      const response = await this.request<{
        entries?: Array<Record<string, unknown>>;
      }>(
        "/ironflow.v1.EntityStreamService/GetEntityHistory",
        { entityId },
        "streams.getEntityHistory",
        undefined,
        true,
      );
      return (response.entries ?? []).map((entry) => ({
        eventName: String(entry.eventName ?? ""),
        data: Object.hasOwn(entry, "eventDataValue") ? entry.eventDataValue : entry.eventData,
        version: Number(entry.entityVersion ?? 0),
        timestamp: String(entry.timestamp ?? ""),
      }));
    },
  };

  /**
   * SQL-backed projections
   *
   * Create materialized SQL tables from event streams. Events are processed
   * server-side using parameterized SQL handlers.
   *
   * @example
   * ```typescript
   * // Create a SQL projection
   * await client.sqlProjections.create({
   *   name: "board",
   *   tableSql: "CREATE TABLE proj_board (id TEXT PRIMARY KEY, title TEXT, status TEXT)",
   *   eventHandlers: {
   *     "issue.created": "INSERT INTO proj_board (id, title, status) VALUES (:entity_id, :data.title, 'OPEN')",
   *     "issue.status_changed": "UPDATE proj_board SET status = :data.to WHERE id = :entity_id",
   *   },
   *   events: ["issue.created", "issue.status_changed"],
   * });
   *
   * // Query the projection
   * const result = await client.sqlProjections.query("board", {
   *   where: "status = 'OPEN'",
   *   orderBy: "title ASC",
   *   limit: 50,
   * });
   * ```
   */
  readonly sqlProjections = {
    /**
     * Create a SQL-backed projection with a materialized table and event handlers.
     */
    create: async (
      input: CreateSQLProjectionInput
    ): Promise<{ name: string; status: string }> => {
      const response = await this.request<{
        name: string;
        status: string;
      }>("/ironflow.v1.ProjectionService/CreateSQLProjection", {
        name: input.name,
        table_sql: input.tableSql,
        event_handlers: input.eventHandlers,
        events: input.events,
        description: input.description ?? "",
      }, "sqlProjections.create");
      return { name: response.name, status: response.status };
    },

    /**
     * Query a SQL-backed projection table with optional filtering, ordering, and pagination.
     */
    query: async (
      name: string,
      options?: QuerySQLProjectionOptions
    ): Promise<SQLProjectionQueryResult> => {
      const response = await this.request<{
        columns: string[];
        rows?: Array<{ values: string[]; typedValues?: SQLProjectionValue[] }>;
        totalCount: number;
      }>("/ironflow.v1.ProjectionService/QuerySQLProjection", {
        name,
        where: options?.where ?? "",
        order_by: options?.orderBy ?? "",
        limit: options?.limit ?? 100,
        offset: options?.offset ?? 0,
      }, "sqlProjections.query");
      return {
        columns: response.columns ?? [],
        rows: (response.rows ?? []).map((r) => r.values),
        typedRows: (response.rows ?? []).map((r) => r.typedValues ?? []),
        totalCount: response.totalCount ?? 0,
      };
    },
  };

  /**
   * API key management
   *
   * @example
   * ```typescript
   * // Create an API key
   * const { key } = await client.apiKeys.create({ name: "ci-key" });
   *
   * // List all API keys
   * const keys = await client.apiKeys.list();
   *
   * // Rotate a key
   * const rotated = await client.apiKeys.rotate(keys[0].id);
   * ```
   */
  readonly apiKeys = {
    /** Create a new API key */
    create: async (input: CreateAPIKeyInput): Promise<APIKeyWithSecret> => {
      return this.restRequest<APIKeyWithSecret>("POST", "/api/v1/apikeys", input, "apiKeys.create");
    },
    /** List all API keys */
    list: async (): Promise<APIKey[]> => {
      return this.restRequest<APIKey[]>("GET", "/api/v1/apikeys", undefined, "apiKeys.list");
    },
    /** Get an API key by ID */
    get: async (id: string): Promise<APIKey> => {
      return this.restRequest<APIKey>("GET", `/api/v1/apikeys/${id}`, undefined, "apiKeys.get");
    },
    /** Delete an API key */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/apikeys/${id}`, undefined, "apiKeys.delete");
    },
    /** Rotate an API key (generates a new secret) */
    rotate: async (id: string): Promise<APIKeyWithSecret> => {
      return this.restRequest<APIKeyWithSecret>("POST", `/api/v1/apikeys/${id}/rotate`, undefined, "apiKeys.rotate");
    },
  };

  /**
   * Organization management (enterprise)
   *
   * @example
   * ```typescript
   * const org = await client.orgs.create({ name: "Acme Corp" });
   * const orgs = await client.orgs.list();
   * await client.orgs.update(org.id, { name: "Acme Inc" });
   * ```
   */
  readonly orgs = {
    /** Create a new organization */
    create: async (input: CreateOrgInput): Promise<Organization> => {
      return this.restRequest<Organization>("POST", "/api/v1/orgs", input, "orgs.create");
    },
    /** List all organizations */
    list: async (): Promise<Organization[]> => {
      return this.restRequest<Organization[]>("GET", "/api/v1/orgs", undefined, "orgs.list");
    },
    /** Get an organization by ID */
    get: async (id: string): Promise<Organization> => {
      return this.restRequest<Organization>("GET", `/api/v1/orgs/${id}`, undefined, "orgs.get");
    },
    /** Update an organization */
    update: async (id: string, input: UpdateOrgInput): Promise<Organization> => {
      return this.restRequest<Organization>("PATCH", `/api/v1/orgs/${id}`, input, "orgs.update");
    },
    /** Delete an organization */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/orgs/${id}`, undefined, "orgs.delete");
    },
  };

  /**
   * Role management (enterprise)
   *
   * @example
   * ```typescript
   * const role = await client.roles.create({ name: "deployer", org_id: orgId });
   * await client.roles.assignPolicy(role.id, policyId);
   * const roles = await client.roles.list(orgId);
   * ```
   */
  readonly roles = {
    /** Create a new role */
    create: async (input: CreateRoleInput): Promise<Role> => {
      return this.restRequest<Role>("POST", "/api/v1/roles", input, "roles.create");
    },
    /** List roles, optionally filtered by organization */
    list: async (orgId?: string): Promise<Role[]> => {
      const query = orgId ? `?org_id=${encodeURIComponent(orgId)}` : "";
      return this.restRequest<Role[]>("GET", `/api/v1/roles${query}`, undefined, "roles.list");
    },
    /** Get a role by ID */
    get: async (id: string): Promise<Role> => {
      return this.restRequest<Role>("GET", `/api/v1/roles/${id}`, undefined, "roles.get");
    },
    /** Update a role */
    update: async (id: string, input: UpdateRoleInput): Promise<Role> => {
      return this.restRequest<Role>("PATCH", `/api/v1/roles/${id}`, input, "roles.update");
    },
    /** Delete a role */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/roles/${id}`, undefined, "roles.delete");
    },
    /** Assign a policy to a role */
    assignPolicy: async (roleId: string, policyId: string): Promise<void> => {
      await this.restRequest<void>("POST", `/api/v1/roles/${roleId}/policies`, {
        policy_id: policyId,
      }, "roles.assignPolicy");
    },
    /** Remove a policy from a role */
    removePolicy: async (roleId: string, policyId: string): Promise<void> => {
      await this.restRequest<void>(
        "DELETE",
        `/api/v1/roles/${roleId}/policies/${policyId}`,
        undefined,
        "roles.removePolicy"
      );
    },
    /** List policies assigned to a role. */
    listPolicies: async (roleId: string): Promise<Policy[]> => {
      const response = await this.restRequest<{ policies?: Policy[] }>(
        "GET",
        `/api/v1/roles/${encodeURIComponent(roleId)}/policies`,
        undefined,
        "roles.listPolicies"
      );
      return response.policies ?? [];
    },
  };

  /**
   * Policy management (enterprise)
   *
   * @example
   * ```typescript
   * // #943: effect="allow" is rejected at write. Use deny + CEL condition,
   * // or grant capabilities via RBAC role assignment (Layer 1).
   * const policy = await client.policies.create({
   *   name: "deny-prod-emit",
   *   effect: "deny",
   *   actions: "emit:*",
   *   resources: "irn:*:prod:*",
   *   condition: 'request.environment == "production"',
   *   org_id: orgId,
   * });
   * const policies = await client.policies.list(orgId);
   * ```
   */
  readonly policies = {
    /** Create a new policy */
    create: async (input: CreatePolicyInput): Promise<Policy> => {
      return this.restRequest<Policy>("POST", "/api/v1/policies", input, "policies.create");
    },
    /** List policies, optionally filtered by organization */
    list: async (orgId?: string): Promise<Policy[]> => {
      const query = orgId ? `?org_id=${encodeURIComponent(orgId)}` : "";
      return this.restRequest<Policy[]>("GET", `/api/v1/policies${query}`, undefined, "policies.list");
    },
    /** Get a policy by ID */
    get: async (id: string): Promise<Policy> => {
      return this.restRequest<Policy>("GET", `/api/v1/policies/${id}`, undefined, "policies.get");
    },
    /** Update a policy */
    update: async (id: string, input: UpdatePolicyInput): Promise<Policy> => {
      return this.restRequest<Policy>("PATCH", `/api/v1/policies/${id}`, input, "policies.update");
    },
    /** Delete a policy */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/policies/${id}`, undefined, "policies.delete");
    },
  };

  /**
   * Projection management
   *
   * @example
   * ```typescript
   * const state = await client.projections.get("order-summary");
   * const statuses = await client.projections.list();
   * await client.projections.rebuild("order-summary");
   * ```
   */
  readonly projections = {
    /**
     * Get the current materialized state of a projection.
     *
     * Returns a flat `ProjectionStateResult<TState>` (see `@ironflow/core`).
     * The server returns a wrapped envelope and this method peels it via
     * `peelProjectionEnvelope`. See issue #610 / CHANGELOG 0.20.0.
     *
     * For a freshly registered projection with no events applied, returns
     * empty `state`, `lastEventTime: undefined`, `version: 0`.
     */
    get: async <TState = unknown>(
      name: string,
      options?: GetProjectionOptions,
    ): Promise<ProjectionStateResult<TState>> => {
      const raw = await this.request<Record<string, unknown>>(
        "/ironflow.v1.ProjectionService/GetProjection",
        { name, partition: options?.partition },
        "projections.get",
        undefined,
        true,
      );
      return projectionStateFromWire<TState>(
        raw,
        options?.partition || undefined,
      );
    },
    /** List all projection statuses */
    list: async (): Promise<ProjectionStatusInfo[]> => {
      const raw = await this.request<{
        projections?: Array<{
          name?: string;
          status?: string;
          errorMessage?: string;
        }>;
      }>(
        "/ironflow.v1.ProjectionService/ListProjections",
        {},
        "projections.list",
        undefined,
        true,
      );
      return (raw.projections ?? []).map(projectionStatusFromWire);
    },
    /** List materialized partition keys for a projection. */
    listPartitions: async (
      name: string,
      options: ListProjectionPartitionsOptions = {}
    ): Promise<ListProjectionPartitionsResult> => {
      const query = new URLSearchParams();
      if (options.query) query.set("q", options.query);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query}` : "";
      return this.restRequest<ListProjectionPartitionsResult>(
        "GET",
        `/api/v1/projections/${encodeURIComponent(name)}/partitions${suffix}`,
        undefined,
        "projections.listPartitions"
      );
    },
    /** Get operational status for a projection */
    getStatus: async (name: string): Promise<ProjectionStatusInfo> => {
      const p = await this.request<Record<string, unknown>>(
        "/ironflow.v1.ProjectionService/GetProjectionStatus",
        { name },
        "projections.getStatus",
        undefined,
        true,
      );
      const result = {...projectionStatusFromWire(p), last_event_seq:Number(p.lastEventSeq ?? 0), error_message:String(p.errorMessage ?? ""), updated_at:String(p.updatedAt ?? "")};
      return result;
    },
    /** Trigger a full rebuild of a projection */
    rebuild: async (name: string): Promise<RebuildJob> => {
      return rebuildJobFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.ProjectionService/RebuildProjection",
          { name },
          "projections.rebuild",
          undefined,
          true,
        ),
      );
    },
    /** Get the status of an in-progress or completed rebuild job */
    getRebuildJob: async (name: string): Promise<RebuildJob> => {
      return rebuildJobFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.ProjectionService/GetRebuildJob",
          { name },
          "projections.getRebuildJob",
          undefined,
          true,
        ),
      );
    },
    /** Delete a projection */
    delete: async (name: string): Promise<void> => {
      await this.restRequest<void>(
        "DELETE",
        `/api/v1/projections/${encodeURIComponent(name)}`,
        undefined,
        "projections.delete"
      );
    },
    /** Pause a projection (stop consuming new events) */
    pause: async (name: string): Promise<void> => {
      await this.request(
        "/ironflow.v1.ProjectionService/PauseProjection",
        { name },
        "projections.pause",
        undefined,
        true,
      );
    },
    /** Resume a paused projection */
    resume: async (name: string): Promise<void> => {
      await this.request(
        "/ironflow.v1.ProjectionService/ResumeProjection",
        { name },
        "projections.resume",
        undefined,
        true,
      );
    },
    /** Cancel an in-progress rebuild */
    cancelRebuild: async (name: string): Promise<void> => {
      await this.request(
        "/ironflow.v1.ProjectionService/CancelRebuild",
        { name },
        "projections.cancelRebuild",
        undefined,
        true,
      );
    },
    /**
     * Wait until the named projection has processed events up to `minSeq`,
     * or the timeout elapses. Read-your-writes primitive for CQRS.
     * `streams.append` returns no sequence (appends run through the
     * transactional outbox) — resolve its `eventId` to a sequence with
     * `projections.waitForEvent` first.
     *
     * ```typescript
     * const { eventId } = await client.streams.append(orderId, event);
     * const { targetSeq } = await client.projections.waitForEvent(
     *   eventId, "order-detail-view", { timeoutMs: 5000 });
     * await client.projections.waitForCatchup("order-detail-view", {
     *   minSeq: targetSeq,
     *   partition: orderId,
     *   timeoutMs: 5000,
     * });
     * ```
     *
     * Errors: 400 (partition rejected — external projection, or a managed
     * projection that declares no partition key and has no state row under
     * the requested partition), 404 (projection not found), 409
     * (paused/rebuilding), 429 (wait capacity exceeded, or more than 64
     * distinct partitions of this projection already have a live wait), 503
     * (the shared poller stopped before this wait attached — retryable, a
     * retry spawns a fresh one).
     *
     * Issue #473.
     */
    waitForCatchup: async (
      name: string,
      opts: { minSeq: bigint | number; timeoutMs?: number; partition?: string },
    ): Promise<WaitResult> => {
      const raw = await this.request<WaitWireResult>(
        "/ironflow.v1.ProjectionService/WaitProjectionCatchup",
        {
          name,
          minSeq: String(opts.minSeq),
          partition: opts.partition,
          ...(opts.timeoutMs !== undefined && opts.timeoutMs !== 0
            ? { timeout: `${opts.timeoutMs / 1000}s` }
            : {}),
        },
        "projections.waitForCatchup",
        undefined,
        true,
      );
      return waitResultFromWire(raw);
    },
    /**
     * Wait on multiple projections in a single request. All items share
     * a single timeout deadline and a single atomic slot reservation on
     * the server — if the server's cap cannot absorb N items, the whole
     * batch is rejected with 429. Per-item failures are returned per
     * element via `error` fields.
     *
     * Max 16 items. Issue #473.
     */
    waitForCatchupBatch: async (
      items: Array<{
        name: string;
        minSeq: bigint | number;
        partition?: string;
      }>,
      opts: { timeoutMs?: number } = {},
    ): Promise<Array<{ result?: WaitResult; error?: string }>> => {
      // Always send minSeq as a string. uint64 sequences can exceed JS's
      // safe-integer range (2^53-1); stringifying keeps the value exact
      // across the JSON boundary and matches protojson's convention for
      // 64-bit ints.
      const body = {
        items: items.map((i) => ({
          name: i.name,
          minSeq: String(i.minSeq),
          ...(i.partition ? { partition: i.partition } : {}),
        })),
        ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0
          ? { timeout: `${opts.timeoutMs / 1000}s` }
          : {}),
      };
      const resp = await this.request<{
        results?: Array<{ result?: WaitWireResult; error?: string }>;
      }>(
        "/ironflow.v1.ProjectionService/WaitProjectionCatchupBatch",
        body,
        "projections.waitForCatchupBatch",
        undefined,
        true,
      );
      return (resp.results ?? []).map((item) => ({
        ...(item.result ? { result: waitResultFromWire(item.result) } : {}),
        ...(item.error ? { error: item.error } : {}),
      }));
    },
    /**
     * Wait for a specific event (identified by `eventId` from a
     * `streams.append` response) to be processed by the given projection.
     * The server resolves eventId → NATS seq internally.
     *
     * Errors: 404 (event not found), 409 (event predates sequence
     * tracking — fall back to waitForCatchup with minSeq from a
     * fresh write), plus the standard wait errors.
     *
     * Issue #473.
     */
    waitForEvent: async (
      eventId: string,
      projection: string,
      opts: { timeoutMs?: number; partition?: string } = {}
    ): Promise<WaitResult> => {
      const body = {
        eventId,
        projection,
        ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? { timeout: `${opts.timeoutMs / 1000}s` } : {}),
        ...(opts.partition ? { partition: opts.partition } : {}),
      };
      const result = await this.request<WaitWireResult>(
        "/ironflow.v1.ProjectionService/WaitForEvent",
        body,
        "projections.waitForEvent", undefined, true
      );
      return waitResultFromWire(result);
    },
  };

  /**
   * Secrets management
   *
   * @example
   * ```typescript
   * await client.secrets.set("stripe-key", "sk_live_...");
   * const secret = await client.secrets.get("stripe-key");
   * const all = await client.secrets.list();
   * await client.secrets.delete("stripe-key");
   * ```
   */
  readonly secrets = {
    /** Get a secret by name (returns value) */
    get: async (name: string): Promise<Secret> => {
      return this.restRequest<Secret>("GET", `/api/v1/secrets/${encodeURIComponent(name)}`, undefined, "secrets.get");
    },
    /** Create a new secret */
    set: async (name: string, value: string): Promise<Secret> => {
      return this.restRequest<Secret>("POST", "/api/v1/secrets", { name, value }, "secrets.set");
    },
    /** Update an existing secret's value */
    update: async (name: string, value: string): Promise<Secret> => {
      return this.restRequest<Secret>("PUT", `/api/v1/secrets/${encodeURIComponent(name)}`, { value }, "secrets.update");
    },
    /** Rename a secret and/or update its description without changing its value. */
    patch: async (name: string, input: PatchSecretInput): Promise<Secret> => {
      if (input.name === undefined && input.description === undefined) {
        throw new ValidationError("Secret patch requires name or description");
      }
      return this.restRequest<Secret>(
        "PATCH",
        `/api/v1/secrets/${encodeURIComponent(name)}`,
        input,
        "secrets.patch"
      );
    },
    /** List all secrets (names only, no values) */
    list: async (): Promise<SecretListEntry[]> => {
      return this.restRequest<SecretListEntry[]>("GET", "/api/v1/secrets", undefined, "secrets.list");
    },
    /** Delete a secret */
    delete: async (name: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/secrets/${encodeURIComponent(name)}`, undefined, "secrets.delete");
    },
  };

  /**
   * Project management
   *
   * @example
   * ```typescript
   * const project = await client.projects.create({ name: "my-service" });
   * const projects = await client.projects.list();
   * await client.projects.update(project.id, { name: "renamed-service" });
   * await client.projects.delete(project.id);
   * ```
   */
  readonly projects = {
    /** List all projects */
    list: async (): Promise<Project[]> => {
      return this.restRequest<Project[]>(
        "GET",
        "/api/v1/projects",
        undefined,
        "projects.list",
      );
    },
    /** Create a new project */
    create: async (input: {
      name: string;
      description?: string;
    }): Promise<Project> => {
      return this.restRequest<Project>(
        "POST",
        "/api/v1/projects",
        input,
        "projects.create",
      );
    },
    /** Update a project */
    update: async (
      id: string,
      input: { name?: string; description?: string },
    ): Promise<Project> => {
      return this.restRequest<Project>(
        "PUT",
        `/api/v1/projects/${encodeURIComponent(id)}`,
        input,
        "projects.update",
      );
    },
    /** Delete a project */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`, undefined, "projects.delete");
    },
  };

  /**
   * Environment management
   *
   * @example
   * ```typescript
   * const env = await client.environments.create({ name: "staging", projectId: "proj_..." });
   * const envs = await client.environments.list();
   * await client.environments.update(env.id, { name: "staging-v2" });
   * await client.environments.delete(env.id);
   * ```
   */
  readonly environments = {
    /** List all environments */
    list: async (): Promise<Environment[]> => {
      return this.restRequest<Environment[]>(
        "GET",
        "/api/v1/environments",
        undefined,
        "environments.list",
      );
    },
    /** Create a new environment */
    create: async (input: {
      name: string;
      project_id: string;
    }): Promise<Environment> => {
      return this.restRequest<Environment>(
        "POST",
        "/api/v1/environments",
        input,
        "environments.create",
      );
    },
    /** Update an environment */
    update: async (
      id: string,
      input: { name?: string },
    ): Promise<Environment> => {
      return this.restRequest<Environment>(
        "PUT",
        `/api/v1/environments/${encodeURIComponent(id)}`,
        input,
        "environments.update",
      );
    },
    /** Delete an environment */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/environments/${encodeURIComponent(id)}`, undefined, "environments.delete");
    },
  };

  /**
   * Event schema registry operations
   *
   * @example
   * ```typescript
   * // Register a schema
   * const schema = await client.schemas.register({
   *   name: "order.placed",
   *   version: 1,
   *   schema: { type: "object", properties: { orderId: { type: "string" } } },
   * });
   *
   * // List all schemas
   * const schemas = await client.schemas.list();
   *
   * // Get latest version of a schema
   * const latest = await client.schemas.get("order.placed");
   *
   * // Get a specific version
   * const v1 = await client.schemas.getVersion("order.placed", 1);
   *
   * // Test an upcast transformation
   * const result = await client.schemas.testUpcast({
   *   eventName: "order.placed",
   *   fromVersion: 1,
   *   toVersion: 2,
   *   data: { orderId: "123" },
   * });
   * ```
   */
  readonly schemas = {
    /** Register a new event schema or version. */
    register: async (input: RegisterSchemaInput): Promise<EventSchema> => {

      const status = await this.request<{ status?: string }>("/ironflow.v1.EventSchemaService/RegisterSchema", { eventName: input.name, version: input.version, schemaJson: JSON.stringify(input.schema) }, "schemas.register", undefined, true);
      return { ...status, event_name: input.name, version: input.version, schema: input.schema, created_at: "" };
    },
    /** List registered schemas, including their documents. */
    list: async (): Promise<EventSchema[]> => {

      const result = await this.request<{ schemas?: SchemaWire[] }>("/ironflow.v1.EventSchemaService/ListSchemas", {}, "schemas.list", undefined, true);
      return (result.schemas ?? []).map(schemaFromWire);
    },
    /** Get the latest version. */
    get: async (name: string): Promise<EventSchema> => {

      return schemaFromWire(await this.request<SchemaWire>("/ironflow.v1.EventSchemaService/GetSchema", { eventName: name }, "schemas.get", undefined, true));
    },
    /** Get a specific positive version. */
    getVersion: async (name: string, version: number): Promise<EventSchema> => {

      if (!Number.isInteger(version) || version <= 0 || version > 2147483647) throw new IronflowError("version must be a positive int32", { code: "invalid_argument", retryable: false });
      return schemaFromWire(await this.request<SchemaWire>("/ironflow.v1.EventSchemaService/GetSchema", { eventName: name, version }, "schemas.getVersion", undefined, true));
    },
    /** Delete a specific version. */
    delete: async (name: string, version: number): Promise<void> => {

      await this.request<unknown>("/ironflow.v1.EventSchemaService/DeleteSchema", { eventName: name, version }, "schemas.delete", undefined, true);
    },
    /** Test an upcast transformation between two schema versions */
    testUpcast: async (input: TestUpcastInput): Promise<UpcastResult> => {
      const { data, ...fields } = input;
      const payload =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? { data }
          : { dataValue: data };
      const result = await this.request<{
        data?: unknown;
        dataValue?: unknown;
      }>(
        "/ironflow.v1.EventSchemaService/TestUpcast",
        { ...fields, ...payload },
        "schemas.testUpcast",
        undefined,
        true,
      );
      return {
        success: true,
        data: "dataValue" in result ? result.dataValue : result.data,
      };
    },
  };

  /**
   * Get the reconstructed state of a run at a specific point in time.
   *
   * @param runId The run ID to query
   * @param timestamp The point in time to reconstruct state at
   */
  async getRunStateAt(runId: string, timestamp: Date): Promise<TimeTravelRunState> {
    return this.request<TimeTravelRunState>(
      "/ironflow.v1.TimeTravelService/GetRunStateAt",
      { run_id: runId, timestamp: timestamp.toISOString() },
      "getRunStateAt"
    );
  }

  /**
   * Get the timeline of events for a run (for time-travel debugging).
   *
   * @param runId The run ID to query
   */
  async getRunTimeline(runId: string): Promise<TimeTravelTimelineEvent[]> {
    const response = await this.request<{ events?: TimeTravelTimelineEvent[] }>(
      "/ironflow.v1.TimeTravelService/GetRunTimeline",
      { run_id: runId },
      "getRunTimeline"
    );
    return response.events ?? [];
  }

  /**
   * Get the output of a specific step at a point in time.
   *
   * @param runId The run ID
   * @param stepId The step ID
   * @param timestamp The point in time to query
   */
  async getStepOutputAt(
    runId: string,
    stepId: string,
    timestamp: Date
  ): Promise<TimeTravelStepOutput> {
    return this.request<TimeTravelStepOutput>(
      "/ironflow.v1.TimeTravelService/GetStepOutputAt",
      { run_id: runId, step_id: stepId, timestamp: timestamp.toISOString() },
      "getStepOutputAt"
    );
  }

  /**
   * Get the audit trail for a run.
   *
   * @param runId The run ID to retrieve the audit trail for
   */
  async getAuditTrail(runId: string): Promise<AuditTrailEntry[]> {
    const response = await this.request<{ entries?: AuditTrailEntry[] }>(
      "/ironflow.v1.AuditService/GetAuditTrail",
      { run_id: runId },
      "getAuditTrail"
    );
    return response.entries ?? [];
  }

  /** Query the environment-wide audit stream. */
  async listAuditEvents(
    options: ListAuditEventsOptions = {}
  ): Promise<AuditTrailResult> {
    const query = new URLSearchParams();
    if (options.runId) query.set("run_id", options.runId);
    if (options.functionId) query.set("function_id", options.functionId);
    if (options.eventType) query.set("event_type", options.eventType);
    if (options.fromTimestamp) query.set("from", options.fromTimestamp);
    if (options.toTimestamp) query.set("to", options.toTimestamp);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.restRequest<{
      events?: Record<string, unknown>[];
      total_count?: number;
      next_cursor?: string;
    }>("GET", `/api/v1/audit${suffix}`, undefined, "listAuditEvents");
    return {
      events: (response.events ?? []).map(auditEventFromWire) as AuditEvent[],
      totalCount: response.total_count ?? 0,
      nextCursor: response.next_cursor || undefined,
    };
  }

  /**
   * Webhook management operations
   *
   * @example
   * ```typescript
   * // List all webhook sources
   * const sources = await client.webhooks.listSources();
   *
   * // Delete a webhook source
   * await client.webhooks.deleteSource("my-webhook");
   *
   * // List deliveries for a source
   * const { deliveries } = await client.webhooks.listDeliveries({ sourceId: "my-webhook" });
   * ```
   */
  readonly webhooks = {
    /**
     * Create a new webhook source.
     *
     * The returned `ingestToken` is the ONLY copy (ADR 0048): the server keeps
     * a hash, so dropping it makes the source unreachable — the provider has
     * no other credential to authenticate with.
     */
    create: async (input: CreateWebhookSourceInput): Promise<WebhookSource> => {
      // Every request body here is snake_case and every response is read
      // through webhookSourceFromWire, because WebhookService registers
      // snakeJSONCodec (internal/server/connect/jsoncodec.go, wired via
      // connecthandler.SnakeJSONHandlerOptions() in server.go). That codec is
      // scoped to THIS service — other Connect handlers still emit camelCase,
      // see ADR 0023.
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/CreateWebhookSource",
          {
            name: input.name,
            event_prefix: input.eventPrefix,
            verify_header: input.verifyHeader ?? "",
            verify_algorithm: input.verifyAlgorithm ?? "",
            verify_secret: input.verifySecret ?? "",
            verify_config: webhookVerifyConfigToWire(input.verifyConfig),
            metadata: input.metadata,
          },
          "webhooks.create",
        ),
      );
    },

    /** Fetch a single webhook source by ID. */
    getSource: async (id: string): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/GetWebhookSource",
          { id },
          "webhooks.getSource",
        ),
      );
    },

    /**
     * Replace the editable fields on a webhook source.
     *
     * FULL-REPLACE, not patch — every omitted field is cleared server-side.
     * Fetch with `getSource` first and copy across what you are not changing;
     * see {@link UpdateWebhookSourceInput} for the example and for why
     * `expectedUpdatedAt` matters more here than on the sibling calls.
     */
    updateSource: async (input: UpdateWebhookSourceInput): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/UpdateWebhookSource",
          {
            id: input.id,
            name: input.name,
            verify_header: input.verifyHeader ?? "",
            verify_algorithm: input.verifyAlgorithm ?? "",
            verify_config: webhookVerifyConfigToWire(input.verifyConfig),
            metadata: input.metadata,
            ...(input.expectedUpdatedAt
              ? { expected_updated_at: input.expectedUpdatedAt }
              : {}),
          },
          "webhooks.updateSource",
        ),
      );
    },

    /**
     * Rotate a source's verify secret (ADR 0024), keeping the prior secret
     * verifying as `prev` for the grace window so in-flight deliveries signed
     * with it still pass.
     */
    rotateSecret: async (input: RotateWebhookSecretInput): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/RotateWebhookSecret",
          {
            id: input.id,
            verify_secret: input.verifySecret,
            // Tri-state + range-validated; see webhookGraceToWire.
            ...webhookGraceToWire(input.graceSeconds),
            ...(input.expectedUpdatedAt
              ? { expected_updated_at: input.expectedUpdatedAt }
              : {}),
          },
          "webhooks.rotateSecret",
        ),
      );
    },

    /**
     * Force-expire the previous secret slot, ending a rotation grace window
     * early. Idempotent — a source with no prev comes back unchanged.
     */
    expireSecretPrev: async (
      id: string,
      expectedUpdatedAt?: string,
    ): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/ExpireWebhookSecretPrev",
          {
            id,
            ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
          },
          "webhooks.expireSecretPrev",
        ),
      );
    },

    /**
     * Stop verifying signatures on a source. The prior secret is preserved as
     * `prev` for the grace window; after it lapses the source ingests
     * unsigned.
     */
    disableSignatureVerification: async (
      input: DisableWebhookSignatureVerificationInput,
    ): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/DisableWebhookSignatureVerification",
          {
            id: input.id,
            // Tri-state + range-validated; see webhookGraceToWire.
            ...webhookGraceToWire(input.graceSeconds),
            ...(input.expectedUpdatedAt
              ? { expected_updated_at: input.expectedUpdatedAt }
              : {}),
          },
          "webhooks.disableSignatureVerification",
        ),
      );
    },

    /**
     * Rotate a source's per-source ingest token (ADR 0048).
     *
     * No grace window — the previous token stops working immediately, so
     * update the provider's URL as soon as this returns. `ingestToken` on the
     * result is the only copy; it cannot be retrieved later.
     */
    rotateIngestToken: async (
      id: string,
      expectedUpdatedAt?: string,
    ): Promise<WebhookSource> => {
      return webhookSourceFromWire(
        await this.request<Record<string, unknown>>(
          "/ironflow.v1.WebhookService/RotateWebhookIngestToken",
          {
            id,
            ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
          },
          "webhooks.rotateIngestToken",
        ),
      );
    },

    /** List all registered webhook sources */
    listSources: async (): Promise<WebhookSource[]> => {
      const response = await this.request<{
        sources?: Array<Record<string, unknown>>;
      }>("/ironflow.v1.WebhookService/ListWebhookSources", { limit: 0, offset: 0 }, "webhooks.listSources");
      return (response.sources ?? []).map(webhookSourceFromWire);
    },

    /** Delete a webhook source by ID */
    deleteSource: async (id: string): Promise<void> => {
      await this.request<Record<string, never>>(
        "/ironflow.v1.WebhookService/DeleteWebhookSource",
        { id },
        "webhooks.deleteSource"
      );
    },

    /** List webhook deliveries with optional filtering */
    listDeliveries: async (opts?: ListWebhookDeliveriesOptions): Promise<{
      deliveries: WebhookDelivery[];
      totalCount: number;
    }> => {
      const response = await this.request<{
        deliveries?: Array<Record<string, unknown>>;
        total_count?: number;
      }>("/ironflow.v1.WebhookService/ListWebhookDeliveries", {
        source_id: opts?.sourceId ?? "",
        status: opts?.status ?? "",
        limit: opts?.limit ?? 0,
        offset: opts?.offset ?? 0,
      }, "webhooks.listDeliveries");
      return {
        deliveries: (response.deliveries ?? []).map(webhookDeliveryFromWire),
        totalCount: response.total_count ?? 0,
      };
    },
  };

  /**
   * User management operations
   *
   * @example
   * ```typescript
   * // Create a user
   * const user = await client.users.create({ email: "alice@example.com", password: "secret", roles: ["admin"] });
   *
   * // List users
   * const users = await client.users.list();
   *
   * // Update a user
   * await client.users.update(user.id, { name: "Alice" });
   *
   * // Delete a user
   * await client.users.delete(user.id);
   * ```
   */
  readonly users = {
    /** Create a new user (admin only) */
    create: async (input: CreateUserInput): Promise<User> => {
      return this.restRequest<User>("POST", "/api/v1/users", input, "users.create");
    },

    /** List all users in the current organization (admin only) */
    list: async (): Promise<User[]> => {
      return this.restRequest<User[]>("GET", "/api/v1/users", undefined, "users.list");
    },

    /** Get a user by ID */
    get: async (id: string): Promise<User> => {
      return this.restRequest<User>("GET", `/api/v1/users/${encodeURIComponent(id)}`, undefined, "users.get");
    },

    /** Update a user's profile (admin only) */
    update: async (id: string, input: UpdateUserInput): Promise<User> => {
      return this.restRequest<User>("PATCH", `/api/v1/users/${encodeURIComponent(id)}`, input, "users.update");
    },

    /** Delete a user (admin only) */
    delete: async (id: string): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/users/${encodeURIComponent(id)}`, undefined, "users.delete");
    },
    /** Change the authenticated user's password. */
    changePassword: async (id: string, input: ChangePasswordInput): Promise<void> => {
      await this.restRequest<void>(
        "PATCH",
        `/api/v1/users/${encodeURIComponent(id)}/password`,
        {
          current_password: input.currentPassword,
          new_password: input.newPassword,
        },
        "users.changePassword"
      );
    },
  };

  /**
   * Tenant management operations (enterprise-only)
   *
   * @example
   * ```typescript
   * // List all tenants
   * const tenants = await client.tenants.list();
   * console.log(tenants.map(t => t.name));
   * ```
   */
  readonly tenants = {
    /** List all tenants (enterprise-only) */
    list: async (): Promise<Tenant[]> => {
      return this.restRequest<Tenant[]>("GET", "/api/v1/tenants", undefined, "tenants.list");
    },
    /** Provision an organization, environment, and initial administrator key. */
    provision: async (input: ProvisionTenantInput): Promise<ProvisionTenantResult> => {
      const response = await this.restRequest<{
        org: { id: string; name: string };
        environment: { id: string; name: string };
        api_key: { key: string; roles?: string[] };
      }>(
        "POST",
        "/api/v1/tenants/provision",
        { org_name: input.orgName, env_name: input.envName ?? "production" },
        "tenants.provision"
      );
      return {
        org: response.org,
        environment: response.environment,
        apiKey: { key: response.api_key.key, roles: response.api_key.roles ?? [] },
      };
    },
  };

  /**
   * KV store operations
   *
   * @example
   * ```typescript
   * const kv = client.kv();
   * const bucket = await kv.createBucket({ name: "sessions", ttlSeconds: 3600 });
   * const handle = kv.bucket("sessions");
   * const { revision } = await handle.put("user.123", { token: "abc" });
   * const entry = await handle.get("user.123");
   * ```
   */
  kv(): KVClient {
    return new KVClient({
      serverUrl: this.serverUrl,
      apiKey: this.apiKey,
      timeout: this.timeout,
      onError: this.onErrorHandler,
    });
  }

  /**
   * Create a CommandDedup instance for atomic command-level idempotency.
   *
   * Uses the claim-first pattern backed by NATS KV. The KV bucket is created
   * lazily on the first operation. Store the returned instance and reuse it
   * across requests — do not call commandDedup() per request.
   *
   * @example
   * ```typescript
   * const dedup = client.commandDedup<OrderResult>("order-commands");
   * const prior = await dedup.tryClaim(commandId, { orderId, claimedAt: new Date().toISOString() });
   * if (prior !== null) return prior;
   * try {
   *   const result = await runOrderHandler();
   *   await dedup.finalize(commandId, result);
   *   return result;
   * } catch (err) {
   *   await dedup.release(commandId).catch(() => {}); // swallow — don't mask the original error
   *   throw err;
   * }
   * ```
   */
  commandDedup<T>(bucketName: string, options?: CommandDedupOptions): CommandDedup<T> {
    return new CommandDedup<T>(this.kv(), bucketName, options?.ttlSeconds);
  }

  /**
   * Config management operations
   *
   * @example
   * ```typescript
   * const config = client.config();
   * await config.set("app", { featureX: true });
   * const { data } = await config.get("app");
   * await config.patch("app", { maxRetries: 5 });
   * const configs = await config.list();
   * await config.delete("app");
   * ```
   */
  config(): ConfigClient {
    return new ConfigClient({
      serverUrl: this.serverUrl,
      apiKey: this.apiKey,
      timeout: this.timeout,
      onError: this.onErrorHandler,
    });
  }

  /**
   * Patch a step's output (hot patching)
   */
  async patchStep(
    stepId: string,
    output: Record<string, unknown>,
    reason?: string
  ): Promise<void> {
    await this.request("/ironflow.v1.IronflowService/PatchStep", { stepId, output, reason: reason || "" }, "patchStep", undefined, true);
  }

  /**
   * Resume a paused or failed run
   *
   * On the Connect RPC since #1963, alongside getRun/listRuns/cancelRun. It
   * used to POST the REST route with its own hand-rolled fetch, which meant a
   * second decode path (mapRestRunResponse, deleted) and a 409 that arrived as
   * an untyped Error. It now shares request()'s typed errors, so a
   * deduplicated resume throws ConflictError, and carries X-Ironflow-Run-ID
   * when called from inside a run like every other RPC. A resume that loses a
   * CAS race throws ContendedError instead — same 409, opposite advice (#2074).
   */
  async resumeRun(runId: string, fromStep?: string): Promise<Run> {
    const response = await this.request<RunWireResponse>(
      API_ENDPOINTS.RESUME_RUN,
      { runId, fromStep: fromStep || "" },
      "resumeRun"
    );
    return mapRunResponse(response);
  }

  /**
   * Pause a running workflow run (scoped injection).
   *
   * @example
   * ```typescript
   * const result = await client.pauseRun("run_abc123");
   * console.log(result.status); // "paused"
   * ```
   */
  async pauseRun(runId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "/ironflow.v1.IronflowService/PauseRun",
      { run_id: runId },
      "pauseRun"
    );
  }

  /**
   * Get the paused state of a run, including completed steps and next step hint.
   *
   * @example
   * ```typescript
   * const state = await client.getPausedState("run_abc123");
   * for (const step of state.steps) {
   *   console.log(step.name, step.output, step.injected);
   * }
   * console.log("Next step:", state.nextStepHint);
   * ```
   */
  async getPausedState(runId: string): Promise<{
    steps: Array<{
      id: string;
      name: string;
      output: unknown;
      injected: boolean;
      completedAt: string;
      /** Step kind: invoke, sleep, wait_for_event, compensate, invoke_function. */
      stepType: string;
      /** Terminal status at snapshot time: "completed" or "failed". */
      status: string;
      /** Error payload for a failed step; null for a completed one. */
      error: unknown;
    }>;
    nextStepHint: string;
    pauseReason: string;
  }> {
    const response = await this.request<{
      steps: Array<{
        id: string;
        name: string;
        output: string;
        injected: boolean;
        completedAt: string;
        stepType?: string;
        status?: string;
        // Proto bytes field: arrives base64-encoded, like output.
        error?: string;
      }>;
      nextStepHint: string;
      pauseReason: string;
    }>("/ironflow.v1.IronflowService/GetPausedState", { run_id: runId }, "getPausedState");

    return {
      steps: (response.steps || []).map((s) => ({
        id: s.id,
        name: s.name,
        output: decodeProtoBytes(s.output),
        injected: s.injected,
        completedAt: s.completedAt,
        // Without these a caller cannot tell a failed step from a completed one,
        // which is the whole reason failed steps are exposed here (#1919).
        stepType: s.stepType ?? "",
        status: s.status ?? "",
        error: decodeProtoBytes(s.error),
      })),
      nextStepHint: response.nextStepHint,
      pauseReason: response.pauseReason,
    };
  }

  /**
   * Inject new output for a step in a paused run (scoped injection).
   *
   * @example
   * ```typescript
   * const result = await client.injectStepOutput(
   *   "run_abc123",
   *   "step_xyz",
   *   { corrected: true },
   *   "Manual correction"
   * );
   * console.log("Previous output:", result.previousOutput);
   * ```
   */
  async injectStepOutput(
    runId: string,
    stepId: string,
    newOutput: unknown,
    reason?: string
  ): Promise<{ stepId: string; previousOutput: unknown }> {
    const response = await this.request<{
      stepId: string;
      previousOutput: string;
    }>("/ironflow.v1.IronflowService/InjectStepOutput", {
      run_id: runId,
      step_id: stepId,
      new_output: encodeProtoBytes(newOutput),
      reason: reason ?? "",
    }, "injectStepOutput");

    return {
      stepId: response.stepId,
      previousOutput: decodeProtoBytes(response.previousOutput),
    };
  }

  /**
   * List registered functions
   */
  async listFunctions(): Promise<unknown[]> {
    const result = await this.request<{
      functions?: Array<Record<string, unknown>>;
    }>(
      "/ironflow.v1.IronflowService/ListFunctions",
      {},
      "listFunctions",
      undefined,
      true,
    );
    return (result.functions ?? []).map(functionListFromWire);
  }

  /**
   * List connected workers
   */
  async listWorkers(): Promise<unknown[]> {
    const endpoint = "/api/v1/workers";
    const url = `${this.serverUrl}${endpoint}`;

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        throw new Error(`List workers failed: ${response.status}`);
      }

      const data = (await response.json()) as { workers: unknown[] };
      return data.workers || [];
    } catch (error) {
      await this.callOnError(error as Error, { method: "listWorkers", endpoint, statusCode: status });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make an HTTP request to the server
   */
  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    method?: string,
    /**
     * Transport deadline override. A synchronous RPC passes
     * `timeout_ms + SYNC_TRANSPORT_HEADROOM` here so the abort never fires
     * before the server's own wait budget expires. Deliberately not clamped to
     * `this.timeout`.
     */
    timeoutMs?: number,
    useSDKErrorTypes = false
  ): Promise<T> {
    const url = `${this.serverUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const runId = getCurrentRunId();
    if (runId) {
      headers["X-Ironflow-Run-ID"] = runId;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs ?? this.timeout);
    let status: number | undefined;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Request failed with status ${response.status}`;
        // The Connect code, kept rather than discarded: two codes serialize to
        // 409 with opposite retry advice and the status cannot tell them
        // apart (#2074).
        let connectCode: string | undefined;
        if (errorBody) {
          try {
            const errorJson = JSON.parse(errorBody);
            if (typeof errorJson.code === "string") {
              connectCode = errorJson.code;
            }
            if (errorJson.message) {
              errorMessage = errorJson.message;
            } else if (errorJson.code) {
              errorMessage = `Error code: ${errorJson.code}`;
            } else {
              errorMessage = errorBody;
            }
          } catch {
            // Not a JSON response, use raw text.
            errorMessage = errorBody;
          }
        }
        if (useSDKErrorTypes) {
          // reason splits the two meanings of `aborted` (#2093): a lost CAS
          // race wrote nothing, an unverified injection wrote the step. Both
          // arrive as aborted/409 and only this header tells them apart.
          throw connectHTTPError(response.status, errorMessage, connectCode ?? (response.status === 409 ? "already_exists" : undefined), {
            authHelp: AUTH_HELP,
            reason: response.headers.get(ERROR_REASON_HEADER) ?? undefined,
          });
        }
        this.throwTypedError(response.status, errorMessage, connectCode);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (method) {
        await this.callOnError(error as Error, { method, endpoint, statusCode: status });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Throw a typed error based on the HTTP status, and — where the status is
   * ambiguous — the Connect code the error body carries. Only 409 needs the
   * second argument today (#2074); `connectCode` is undefined on the REST path,
   * whose bodies carry no code.
   */
  private throwTypedError(status: number, message: string, connectCode?: string): never {
    switch (status) {
      case 401:
        throw new UnauthenticatedError(`${message} — ${AUTH_HELP}`);
      case 402:
        throw new EnterpriseRequiredError(message);
      case 403:
        throw new UnauthorizedError(`${message} — ${AUTH_HELP}`);
      case 409:
        // Two Connect codes land on 409 and want opposite things (#2074).
        // `aborted` is a lost CAS race: nothing was applied, retry. Anything
        // else — `already_exists`, or a REST body carrying no code at all —
        // is a deduplicated resumeRun (#1963): wait, do not retry. Without
        // this case a 409 arrived as a bare IronflowError carrying no status,
        // so the only way to tell either from a real failure was to match the
        // message.
        if (connectCode === "aborted") {
          throw new ContendedError(message);
        }
        throw new ConflictError(message);
      default:
        throw new IronflowError(message);
    }
  }

  /**
   * Make a REST HTTP request to the server (supports GET, POST, PATCH, DELETE)
   */
  private async restRequest<T>(
    httpMethod: string,
    path: string,
    body?: unknown,
    method?: string
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (path === "/api/v1/secrets" || path.startsWith("/api/v1/secrets/")) {
      // Secret routes require an explicit environment header, while the
      // authenticated API key remains the authority for the actual scope.
      headers["X-Ironflow-Environment"] = "current";
    }

    const options: RequestInit = { method: httpMethod, headers };
    if (body && (httpMethod === "POST" || httpMethod === "PATCH" || httpMethod === "PUT")) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let status: number | undefined;

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errBody = await response
          .json()
          .catch(() => ({ error: response.statusText }));
        const message =
          (errBody as Record<string, string>).error ||
          (errBody as Record<string, string>).message ||
          response.statusText;
        this.throwTypedError(response.status, message);
      }

      if (response.status === 204) return undefined as T;

      return response.json() as Promise<T>;
    } catch (error) {
      if (method) {
        await this.callOnError(error as Error, { method, endpoint: path, statusCode: status });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Call the global onError handler if registered.
   * Swallows any errors thrown by the callback.
   */
  private async callOnError(error: Error, context: ErrorContext): Promise<void> {
    if (!this.onErrorHandler) return;
    try {
      await this.onErrorHandler(error, context);
    } catch (callbackError) {
      console.error("[ironflow] onError callback threw:", callbackError);
    }
  }
}

/**
 * Create a new Ironflow client
 *
 * @example
 * ```typescript
 * const client = createClient({ serverUrl: "http://localhost:9123" });
 * ```
 */
export function createClient(config?: IronflowClientConfig): IronflowClient {
  return new IronflowClient(config);
}
