/**
 * Ironflow Node.js Client
 *
 * HTTP client for interacting with the Ironflow server.
 * Provides methods for registering functions, triggering events, and managing runs.
 */

import { getCurrentRunId } from "./internal/run-context.js";
import {
  API_ENDPOINTS,
  DEFAULT_SERVER_URL,
  getServerUrl,
  IronflowError,
  RunFailedError,
  RunCancelledError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
  type EmitSyncResult,
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
  type PublishOptions,
  type PublishResult,
  type TopicInfo,
  type TopicStats,
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
  peelProjectionEnvelope,
  type ProjectionStatusInfo,
  type RebuildJob,
  type WaitResult,
  type TimeTravelRunState,
  type TimeTravelTimelineEvent,
  type TimeTravelStepOutput,
  type AuditTrailEntry,
  type Secret,
  type SecretListEntry,
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
  type WebhookDelivery,
  type ListWebhookDeliveriesOptions,
  type User,
  type CreateUserInput,
  type UpdateUserInput,
  type Tenant,
} from "@ironflow/core";
import { KVClient } from "./kv.js";
import { CommandDedup, type CommandDedupOptions } from "./command-dedup.js";
import { ConfigClient } from "./config-client.js";
import type { OnErrorHandler, ErrorContext } from "./types.js";

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Configuration for the Ironflow client
 */
export interface IronflowClientConfig {
  /** Server URL (default: http://localhost:9123 or IRONFLOW_SERVER_URL env var) */
  serverUrl?: string;
  /** API key for authentication (optional for local dev) */
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
  /** Pause behavior for scoped injection ("hold" or "release") */
  pauseBehavior?: string;
  /** Compensate-on-cancel flag (issue #546 P2). Pull-mode only. */
  compensateOnCancel?: boolean;
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
    this.apiKey = config.apiKey;
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
    if (request.pauseBehavior) body.pauseBehavior = request.pauseBehavior;
    if (request.compensateOnCancel) body.compensateOnCancel = true;
    if (request.cancelOn?.length) body.cancelOn = request.cancelOn;

    const response = await this.request<{ created: boolean }>(

      API_ENDPOINTS.REGISTER_FUNCTION,
      body,
      "registerFunction"
    );

    return { created: response.created };
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

    if (options?.version) body.version = options.version;
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

  /**
   * Emit an event synchronously — waits for the triggered run to complete and returns the result.
   *
   * Calls the TriggerSync endpoint, which blocks until the run finishes or the timeout elapses.
   * Throws RunFailedError if the run fails, RunCancelledError if it is cancelled.
   *
   * @example
   * ```typescript
   * const result = await client.emitSync("order.placed", { orderId: "123" });
   * console.log("Output:", result.output);
   * ```
   */
  async emitSync(
    eventName: string,
    data: unknown,
    options?: { timeout?: number }
  ): Promise<EmitSyncResult> {
    const timeout = options?.timeout ?? 30000;
    const fetchTimeout = timeout + 5000;

    const url = `${this.serverUrl}/ironflow.v1.IronflowService/TriggerSync`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);
    let status: number | undefined;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ event: eventName, data, timeout_ms: timeout }),
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.message) errorMessage = errorJson.message;
          else if (errorJson.code) errorMessage = `Error code: ${errorJson.code}`;
          else errorMessage = errorBody;
        } catch {
          errorMessage = errorBody;
        }
        this.throwTypedError(response.status, errorMessage);
      }

      const body = await response.json() as {
        results?: Array<{
          runId: string;
          functionId: string;
          status: string;
          output: unknown;
          error?: { message: string; code?: string };
          durationMs: number;
        }>;
      };

      if (!body.results?.length) {
        throw new IronflowError("No results returned from TriggerSync", { code: "NO_RESULTS", retryable: false });
      }

      const result = body.results[0];
      if (!result) {
        throw new IronflowError("No results returned from TriggerSync", { code: "NO_RESULTS", retryable: false });
      }

      if (result.status === "failed") {
        throw new RunFailedError(result.runId, result.error);
      }
      if (result.status === "cancelled") {
        throw new RunCancelledError(result.runId);
      }

      return {
        runId: result.runId,
        functionId: result.functionId,
        status: result.status,
        output: result.output,
        durationMs: result.durationMs,
      };
    } catch (error) {
      await this.callOnError(error as Error, { method: "emitSync", endpoint: "/ironflow.v1.IronflowService/TriggerSync", statusCode: status });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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

  /**
   * Get a run by ID
   */
  async getRun(runId: string): Promise<Run> {
    return this.request<Run>(API_ENDPOINTS.GET_RUN, { id: runId }, "getRun");
  }

  /**
   * List runs with optional filtering
   */
  async listRuns(options?: ListRunsOptions): Promise<ListRunsResult> {
    const body: Record<string, unknown> = {};

    if (options?.functionId) body.functionId = options.functionId;
    if (options?.status) body.status = options.status;
    if (options?.limit) body.limit = options.limit;
    if (options?.cursor) body.cursor = options.cursor;

    return this.request<ListRunsResult>(API_ENDPOINTS.LIST_RUNS, body, "listRuns");
  }

  /**
   * Cancel a running workflow
   */
  async cancelRun(runId: string, reason?: string): Promise<Run> {
    return this.request<Run>(API_ENDPOINTS.CANCEL_RUN, {
      id: runId,
      reason: reason || "",
    }, "cancelRun");
  }

  /**
   * Retry a failed run
   */
  async retryRun(runId: string, fromStep?: string): Promise<Run> {
    const body: Record<string, unknown> = { id: runId };
    if (fromStep) body.fromStep = fromStep;
    return this.request<Run>(API_ENDPOINTS.RETRY_RUN, body, "retryRun");
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
      const resp = await this.restRequest<{ streams: StreamListEntry[] }>("GET", "/api/v1/streams", undefined, "streams.listStreams");
      return resp.streams ?? [];
    },

    /**
     * Get the full event history for an entity.
     */
    getEntityHistory: async (entityId: string): Promise<EntityHistoryEntry[]> => {
      const resp = await this.restRequest<{ events: EntityHistoryEntry[] }>("GET", `/api/v1/streams/${encodeURIComponent(entityId)}/history`, undefined, "streams.getEntityHistory");
      return resp.events ?? [];
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
        rows?: Array<{ values: string[] }>;
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
      options?: GetProjectionOptions
    ): Promise<ProjectionStateResult<TState>> => {
      // Normalize empty-string partition to undefined so the helper falls back
      // to "__global__" instead of returning empty-string partition.
      const partition = options?.partition ? options.partition : undefined;
      const path = partition
        ? `/api/v1/projections/${encodeURIComponent(name)}?partition=${encodeURIComponent(partition)}`
        : `/api/v1/projections/${encodeURIComponent(name)}`;
      const raw = await this.restRequest<unknown>(
        "GET",
        path,
        undefined,
        "projections.get"
      );
      return peelProjectionEnvelope<TState>(raw, partition);
    },
    /** List all projection statuses */
    list: async (): Promise<ProjectionStatusInfo[]> => {
      return this.restRequest<ProjectionStatusInfo[]>(
        "GET",
        "/api/v1/projections",
        undefined,
        "projections.list"
      );
    },
    /** Get operational status for a projection */
    getStatus: async (name: string): Promise<ProjectionStatusInfo> => {
      return this.restRequest<ProjectionStatusInfo>(
        "GET",
        `/api/v1/projections/${encodeURIComponent(name)}/status`,
        undefined,
        "projections.getStatus"
      );
    },
    /** Trigger a full rebuild of a projection */
    rebuild: async (name: string): Promise<RebuildJob> => {
      return this.restRequest<RebuildJob>(
        "POST",
        `/api/v1/projections/${encodeURIComponent(name)}/rebuild`,
        undefined,
        "projections.rebuild"
      );
    },
    /** Get the status of an in-progress or completed rebuild job */
    getRebuildJob: async (name: string): Promise<RebuildJob> => {
      return this.restRequest<RebuildJob>(
        "GET",
        `/api/v1/projections/${encodeURIComponent(name)}/rebuild`,
        undefined,
        "projections.getRebuildJob"
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
      await this.restRequest<void>(
        "POST",
        `/api/v1/projections/${encodeURIComponent(name)}/pause`,
        undefined,
        "projections.pause"
      );
    },
    /** Resume a paused projection */
    resume: async (name: string): Promise<void> => {
      await this.restRequest<void>(
        "POST",
        `/api/v1/projections/${encodeURIComponent(name)}/resume`,
        undefined,
        "projections.resume"
      );
    },
    /** Cancel an in-progress rebuild */
    cancelRebuild: async (name: string): Promise<void> => {
      await this.restRequest<void>(
        "POST",
        `/api/v1/projections/${encodeURIComponent(name)}/cancel`,
        undefined,
        "projections.cancelRebuild"
      );
    },
    /**
     * Wait until the named projection has processed events up to `minSeq`,
     * or the timeout elapses. Read-your-writes primitive for CQRS: pair
     * with `sequence` from a `streams.append` response.
     *
     * ```typescript
     * const { sequence } = await client.streams.append(orderId, event);
     * await client.projections.waitForCatchup("order-detail-view", {
     *   minSeq: sequence,
     *   partition: orderId,
     *   timeoutMs: 5000,
     * });
     * ```
     *
     * Errors: 404 (projection not found), 409 (paused/rebuilding/partition
     * unsupported for external), 429 (wait capacity exceeded).
     *
     * Issue #473.
     */
    waitForCatchup: async (
      name: string,
      opts: { minSeq: bigint | number; timeoutMs?: number; partition?: string }
    ): Promise<WaitResult> => {
      const params = new URLSearchParams();
      params.set("minSeq", String(opts.minSeq));
      if (opts.timeoutMs !== undefined) {
        params.set("timeout", String(opts.timeoutMs));
      }
      if (opts.partition) {
        params.set("partition", opts.partition);
      }
      return this.restRequest<WaitResult>(
        "GET",
        `/api/v1/projections/${encodeURIComponent(name)}/catchup?${params.toString()}`,
        undefined,
        "projections.waitForCatchup"
      );
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
      items: Array<{ name: string; minSeq: bigint | number; partition?: string }>,
      opts: { timeoutMs?: number } = {}
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
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      const resp = await this.restRequest<{ results: Array<{ result?: WaitResult; error?: string }> }>(
        "POST",
        "/api/v1/projections/catchup/batch",
        body,
        "projections.waitForCatchupBatch"
      );
      return resp.results ?? [];
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
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.partition ? { partition: opts.partition } : {}),
      };
      return this.restRequest<WaitResult>(
        "POST",
        "/api/v1/projections/wait-for-event",
        body,
        "projections.waitForEvent"
      );
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
      return this.restRequest<Project[]>("GET", "/api/v1/projects", undefined, "projects.list");
    },
    /** Create a new project */
    create: async (input: { name: string; description?: string }): Promise<Project> => {
      return this.restRequest<Project>("POST", "/api/v1/projects", input, "projects.create");
    },
    /** Update a project */
    update: async (id: string, input: { name?: string; description?: string }): Promise<Project> => {
      return this.restRequest<Project>("PUT", `/api/v1/projects/${encodeURIComponent(id)}`, input, "projects.update");
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
      return this.restRequest<Environment[]>("GET", "/api/v1/environments", undefined, "environments.list");
    },
    /** Create a new environment */
    create: async (input: { name: string; project_id: string }): Promise<Environment> => {
      return this.restRequest<Environment>("POST", "/api/v1/environments", input, "environments.create");
    },
    /** Update an environment */
    update: async (id: string, input: { name?: string }): Promise<Environment> => {
      return this.restRequest<Environment>("PUT", `/api/v1/environments/${encodeURIComponent(id)}`, input, "environments.update");
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
    /** Register a new event schema (or a new version of an existing schema) */
    register: async (input: RegisterSchemaInput): Promise<EventSchema> => {
      return this.restRequest<EventSchema>("POST", "/api/v1/events/schemas", {
        event_name: input.name,
        version: input.version,
        schema_json: JSON.stringify(input.schema),
      }, "schemas.register");
    },
    /** List all registered event schemas */
    list: async (): Promise<EventSchema[]> => {
      const resp = await this.restRequest<{ schemas: EventSchema[] }>("GET", "/api/v1/events/schemas", undefined, "schemas.list");
      return resp.schemas ?? [];
    },
    /** Get the latest version of an event schema by name */
    get: async (name: string): Promise<EventSchema> => {
      return this.restRequest<EventSchema>("GET", `/api/v1/events/schemas/${encodeURIComponent(name)}`, undefined, "schemas.get");
    },
    /** Get a specific version of an event schema */
    getVersion: async (name: string, version: number): Promise<EventSchema> => {
      return this.restRequest<EventSchema>("GET", `/api/v1/events/schemas/${encodeURIComponent(name)}/${version}`, undefined, "schemas.getVersion");
    },
    /** Delete a specific version of an event schema */
    delete: async (name: string, version: number): Promise<void> => {
      await this.restRequest<void>("DELETE", `/api/v1/events/schemas/${encodeURIComponent(name)}/${version}`, undefined, "schemas.delete");
    },
    /** Test an upcast transformation between two schema versions */
    testUpcast: async (input: TestUpcastInput): Promise<UpcastResult> => {
      return this.restRequest<UpcastResult>("POST", "/api/v1/events/upcast", input, "schemas.testUpcast");
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
    /** Create a new webhook source */
    create: async (input: CreateWebhookSourceInput): Promise<WebhookSource> => {
      const response = await this.request<{
        id: string;
        eventPrefix: string;
        verifyHeader?: string;
        verifyAlgorithm?: string;
        sourceType?: string;
        metadata?: Record<string, unknown>;
        createdAt?: string;
        updatedAt?: string;
      }>("/ironflow.v1.WebhookService/CreateWebhookSource", {
        id: input.id,
        event_prefix: input.eventPrefix,
        verify_header: input.verifyHeader ?? "",
        verify_algorithm: input.verifyAlgorithm ?? "",
        verify_secret: input.verifySecret ?? "",
        metadata: input.metadata,
      }, "webhooks.create");
      return {
        id: response.id,
        eventPrefix: response.eventPrefix,
        verifyHeader: response.verifyHeader,
        verifyAlgorithm: response.verifyAlgorithm,
        sourceType: response.sourceType,
        metadata: response.metadata,
        createdAt: response.createdAt,
        updatedAt: response.updatedAt,
      };
    },

    /** List all registered webhook sources */
    listSources: async (): Promise<WebhookSource[]> => {
      const response = await this.request<{
        sources?: Array<{
          id: string;
          eventPrefix: string;
          verifyHeader?: string;
          verifyAlgorithm?: string;
          sourceType?: string;
          metadata?: Record<string, unknown>;
          createdAt?: string;
          updatedAt?: string;
        }>;
      }>("/ironflow.v1.WebhookService/ListWebhookSources", { limit: 0, offset: 0 }, "webhooks.listSources");
      return (response.sources ?? []).map((s) => ({
        id: s.id,
        eventPrefix: s.eventPrefix,
        verifyHeader: s.verifyHeader,
        verifyAlgorithm: s.verifyAlgorithm,
        sourceType: s.sourceType,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
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
        deliveries?: Array<{
          id: string;
          sourceId: string;
          externalId?: string;
          status: string;
          eventId?: string;
          error?: string;
          createdAt?: string;
        }>;
        totalCount?: number;
      }>("/ironflow.v1.WebhookService/ListWebhookDeliveries", {
        source_id: opts?.sourceId ?? "",
        status: opts?.status ?? "",
        limit: opts?.limit ?? 0,
        offset: opts?.offset ?? 0,
      }, "webhooks.listDeliveries");
      return {
        deliveries: (response.deliveries ?? []).map((d) => ({
          id: d.id,
          sourceId: d.sourceId,
          externalId: d.externalId,
          status: d.status,
          eventId: d.eventId,
          error: d.error,
          createdAt: d.createdAt,
        })),
        totalCount: response.totalCount ?? 0,
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
    const endpoint = "/api/v1/steps/patch";
    const url = `${this.serverUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ step_id: stepId, output, reason: reason || "" }),
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(errorBody || `Patch step failed: ${response.status}`);
      }
    } catch (error) {
      await this.callOnError(error as Error, { method: "patchStep", endpoint, statusCode: status });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Resume a paused or failed run
   */
  async resumeRun(runId: string, fromStep?: string): Promise<Run> {
    const endpoint = "/api/v1/runs/resume";
    const url = `${this.serverUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ run_id: runId, from_step: fromStep || "" }),
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(errorBody || `Resume run failed: ${response.status}`);
      }

      return response.json() as Promise<Run>;
    } catch (error) {
      await this.callOnError(error as Error, { method: "resumeRun", endpoint, statusCode: status });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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
      }>;
      nextStepHint: string;
      pauseReason: string;
    }>("/ironflow.v1.IronflowService/GetPausedState", { run_id: runId }, "getPausedState");

    return {
      steps: (response.steps || []).map((s) => ({
        id: s.id,
        name: s.name,
        output: s.output ? JSON.parse(s.output) : null,
        injected: s.injected,
        completedAt: s.completedAt,
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
      new_output: JSON.stringify(newOutput),
      reason: reason ?? "",
    }, "injectStepOutput");

    return {
      stepId: response.stepId,
      previousOutput: response.previousOutput
        ? JSON.parse(response.previousOutput)
        : null,
    };
  }

  /**
   * List registered functions
   */
  async listFunctions(): Promise<unknown[]> {
    const endpoint = "/api/v1/functions";
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
        throw new Error(`List functions failed: ${response.status}`);
      }

      const data = (await response.json()) as { functions: unknown[] };
      return data.functions || [];
    } catch (error) {
      await this.callOnError(error as Error, { method: "listFunctions", endpoint, statusCode: status });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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
    method?: string
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
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
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
        if (errorBody) {
          try {
            const errorJson = JSON.parse(errorBody);
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
        this.throwTypedError(response.status, errorMessage);
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
   * Throw a typed error based on HTTP status code.
   */
  private throwTypedError(status: number, message: string): never {
    switch (status) {
      case 401:
        throw new UnauthenticatedError(message);
      case 402:
        throw new EnterpriseRequiredError(message);
      case 403:
        throw new UnauthorizedError(message);
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
