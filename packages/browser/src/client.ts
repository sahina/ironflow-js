/**
 * Ironflow Browser Client
 *
 * Singleton client for browser-based real-time interactions with Ironflow.
 */

import type {
  Logger,
  Run,
  RunStatus,
  ListRunsOptions,
  ListRunsResult,
  InvokeResult,
  EmitOptions,
  EmitResult,
  SubscriptionErrorInfo,
  SubscriptionCallbacks,
  Subscription,
  AckableSubscription,
  ConnectionState,
  AppendEventInput,
  AppendOptions,
  AppendResult,
  ReadStreamOptions,
  StreamEvent,
  StreamInfo,
  StreamSnapshot,
  EntitySubscribeOptions,
  GetProjectionOptions,
  RebuildProjectionOptions,
  ProjectionStatusInfo,
  WaitResult,
  WaitProgress,
  QuerySQLProjectionOptions,
  SQLProjectionQueryResult,
  ProjectionStateResult,
  ProjectionSubscriptionCallbacks,
  TimeTravelRunStateSnapshot,
  TimeTravelTimelineEvent,
  TimeTravelStepOutputSnapshot,
  APIKey,
  APIKeyWithSecret,
  CreateAPIKeyInput,
  Organization,
  CreateOrgInput,
  UpdateOrgInput,
  Role,
  CreateRoleInput,
  UpdateRoleInput,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
  EventSchema,
  RegisterSchemaInput,
  TestUpcastInput,
  UpcastResult,
  WebhookSource,
  CreateWebhookSourceInput,
  WebhookDelivery,
  ListWebhookDeliveriesOptions,
  AuditEvent,
  AuditTrailResult,
  GetAuditTrailOptions,
  User,
  CreateUserInput,
  UpdateUserInput,
  Tenant,
} from "@ironflow/core";
import {
  NotConfiguredError,
  IronflowError,
  RunFailedError,
  RunCancelledError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
  ValidationError,
  createLogger,
  createNoopLogger,
  DEFAULT_TIMEOUTS,
  HEADERS,
  TriggerResponseSchema,
  TriggerSyncResponseSchema,
  RunResponseSchema,
  ListRunsResponseSchema,
  RunStatusSchema,
  ErrorResponseSchema,
  safeJsonParse,
  patterns,
  peelProjectionEnvelope,
  type EmitSyncResult,
} from "@ironflow/core";
import type { IronflowConfig, IronflowConfigOptions } from "./config.js";
import { mergeConfig } from "./config.js";
import {
  SubscriptionManager,
  type BrowserSubscribeOptions,
  type SubscriptionGroup,
} from "./subscription.js";
import { createWebSocketTransport } from "./transport/websocket.js";
import { createConnectRPCTransport } from "./transport/connectrpc.js";
import { filterWaitStreamFrames } from "./projection-stream.js";
import type { Transport, TransportOptions } from "./transport/types.js";
import { BrowserKVClient } from "./kv.js";
import { BrowserConfigClient } from "./config-client.js";
import { createAgentsNamespace, type AgentsNamespace } from "./agents/index.js";
import type { z } from "zod";

/**
 * Ironflow browser client singleton
 */
class IronflowClient {
  private config: IronflowConfig | null = null;
  private logger: Logger = createNoopLogger();
  private transport: Transport | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private visibilityHandler: (() => void) | null = null;

  /**
   * `agents` namespace — browser helpers for `agent()` functions.
   *
   * @example
   * ```typescript
   * const result = await ironflow.agents.invoke("my-agent", { task: "..." });
   * console.log(result.runId, result.output);
   *
   * const sub = await ironflow.agents.subscribe(runId, {
   *   onStep: (e) => console.log("step", e.stepId, e.type),
   *   onComplete: (r) => console.log("done", r.output),
   * });
   * ```
   */
  public readonly agents: AgentsNamespace = createAgentsNamespace({
    invoke: (functionId, options) => this.invoke(functionId, options),
    subscribe: (pattern, cbs) => this.subscribe(pattern, cbs),
    cancelRun: (runId, reason) => this.cancelRun(runId, reason),
    getProjection: (name, options) => this.getProjection(name, options),
    waitForProjectionCatchup: (name, opts) =>
      this.waitForProjectionCatchup(name, opts),
  });

  /**
   * Configure the client
   *
   * Must be called before any other operations.
   */
  configure(options: IronflowConfigOptions = {}): void {
    this.config = mergeConfig(options);

    // Set up logger
    if (this.config.logger === false) {
      this.logger = createNoopLogger();
    } else if (this.config.logger) {
      this.logger = this.config.logger;
    } else {
      this.logger = createLogger({ prefix: "[ironflow]" });
    }

    // Clean up existing resources
    this.cleanup();

    // Create transport
    const transportOptions: TransportOptions = {
      auth: this.config.auth,
      autoReconnect: this.config.reconnect.enabled,
      reconnectDelay: this.config.reconnect.backoff.initial,
      maxReconnectDelay: this.config.reconnect.backoff.max,
      reconnectBackoff: this.config.reconnect.backoff.multiplier,
      environment: this.config.environment,
    };

    // Create transport based on config (ConnectRPC by default)
    if (this.config.transport === "websocket") {
      this.transport = createWebSocketTransport(
        this.config.serverUrl,
        transportOptions
      );
    } else {
      // Default to ConnectRPC
      this.transport = createConnectRPCTransport(
        this.config.serverUrl,
        transportOptions
      );
    }

    // Create subscription manager
    this.subscriptionManager = new SubscriptionManager(
      this.transport,
      this.config.logger
    );

    // Set up visibility handling
    if (this.config.visibility.pauseOnHidden && typeof document !== "undefined") {
      this.setupVisibilityHandling();
    }

    this.logger.info("Ironflow client configured", {
      serverUrl: this.config.serverUrl,
      transport: this.config.transport,
    });
  }

  /**
   * Check if the client is configured
   */
  get isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Detect which transport the server supports
   *
   * Returns the best available transport based on server capabilities.
   * ConnectRPC is preferred over WebSocket.
   *
   * @example
   * ```typescript
   * const transport = await ironflow.detectTransport();
   * // Returns 'connectrpc' | 'websocket'
   * ```
   */
  async detectTransport(): Promise<"connectrpc" | "websocket"> {
    const serverUrl = this.config?.serverUrl ?? "http://localhost:9123";

    try {
      // Try to get server capabilities via ConnectRPC endpoint
      const detectHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.config?.environment) {
        detectHeaders[HEADERS.ENVIRONMENT] = this.config.environment;
      }

      const response = await fetch(
        `${serverUrl}/ironflow.v1.IronflowService/GetCapabilities`,
        {
          method: "POST",
          headers: detectHeaders,
          body: "{}",
        }
      );

      if (response.ok) {
        const data = await response.json();
        const transports = data.transports as string[] | undefined;

        // Check if server explicitly supports connectrpc
        if (transports?.includes("connectrpc") || transports?.includes("grpc")) {
          return "connectrpc";
        }

        // Server responded, so ConnectRPC endpoint works
        return "connectrpc";
      }
    } catch {
      // ConnectRPC not available
    }

    // Fall back to WebSocket
    return "websocket";
  }

  /**
   * Get the current configuration
   */
  getConfig(): IronflowConfig {
    if (!this.config) {
      throw new NotConfiguredError();
    }
    return this.config;
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to the Ironflow server
   */
  async connect(): Promise<void> {
    this.ensureConfigured();
    await this.subscriptionManager!.connect();
  }

  /**
   * Disconnect from the Ironflow server
   */
  disconnect(): void {
    if (this.subscriptionManager) {
      this.subscriptionManager.disconnect();
    }
  }

  /**
   * Register a callback for connection state changes
   */
  onConnectionChange(callback: (state: ConnectionState) => void): () => void {
    this.ensureConfigured();
    return this.subscriptionManager!.onConnectionChange(callback);
  }

  /**
   * Get current connection state
   */
  get connectionState(): ConnectionState {
    if (!this.subscriptionManager) {
      return "disconnected";
    }
    return this.subscriptionManager.connectionState;
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  /**
   * Subscribe to events matching a pattern
   *
   * @example
   * ```typescript
   * // Basic subscription
   * const sub = await ironflow.subscribe('events:order.*', {
   *   onEvent: (event) => console.log(event),
   * });
   *
   * // Multiple patterns
   * const sub = await ironflow.subscribe(['system.run.*', 'events:order.*'], {
   *   onEvent: (event) => { ... }
   * });
   *
   * // With options
   * const sub = await ironflow.subscribe('events:*', {
   *   onEvent: (e) => { ... },
   *   replay: 10,
   *   trackState: true,
   *   ackMode: 'manual',
   * });
   * ```
   */
  subscribe<T = unknown>(
    pattern: string | string[],
    callbacksAndOptions: SubscriptionCallbacks<T> & BrowserSubscribeOptions
  ): Promise<Subscription | AckableSubscription> {
    this.ensureConfigured();
    return this.subscriptionManager!.subscribe<T>(pattern, callbacksAndOptions);
  }

  /**
   * Create a subscription group for batch management
   *
   * @example
   * ```typescript
   * const group = ironflow.subscriptionGroup();
   * await group.add('system.run.*', { onEvent: handleRun });
   * await group.add('events:payment.*', { onEvent: handlePayment });
   * // Later:
   * group.unsubscribeAll();
   * ```
   */
  subscriptionGroup(): SubscriptionGroup {
    this.ensureConfigured();
    return this.subscriptionManager!.createGroup();
  }

  /**
   * Register a global error handler
   */
  onError(callback: (error: SubscriptionErrorInfo) => void): () => void {
    this.ensureConfigured();
    return this.subscriptionManager!.onError(callback);
  }

  /**
   * Number of currently active subscriptions. Useful for leak audits and
   * diagnostics. Returns 0 if the client is not configured.
   */
  getActiveSubscriptionCount(): number {
    return this.subscriptionManager?.activeSubscriptionCount ?? 0;
  }

  // ============================================================================
  // Workflow Operations
  // ============================================================================

  /**
   * Invoke a workflow function by ID
   *
   * @example
   * ```typescript
   * const run = await ironflow.invoke<OrderInput, OrderOutput>('process-order', {
   *   data: { orderId: '123' }
   * });
   * ```
   */
  async invoke<TInput = unknown>(
    functionId: string,
    options: { data: TInput; idempotencyKey?: string }
  ): Promise<InvokeResult> {
    this.ensureConfigured();

    const response = await this.request(
      TriggerResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/Trigger",
      {
        event: functionId,
        data: options.data,
        idempotency_key: options.idempotencyKey,
      }
    );

    return {
      runIds: response.runIds ?? [],
      eventId: response.eventId,
    };
  }

  /**
   * Get run status
   */
  async getRun(runId: string): Promise<Run> {
    this.ensureConfigured();

    const response = await this.request(
      RunResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/GetRun",
      { id: runId }
    );

    return this.mapRunResponse(response);
  }

  /**
   * List runs with filtering
   */
  async listRuns(options?: ListRunsOptions): Promise<ListRunsResult> {
    this.ensureConfigured();

    const response = await this.request(
      ListRunsResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/ListRuns",
      {
        function_id: options?.functionId,
        status: options?.status?.toUpperCase(),
        limit: options?.limit,
        cursor: options?.cursor,
      }
    );

    return {
      runs: (response.runs ?? []).map((r) => this.mapRunResponse(r)),
      nextCursor: response.nextCursor,
      totalCount: response.totalCount ?? 0,
    };
  }

  /**
   * Cancel a running run
   */
  async cancelRun(runId: string, reason?: string): Promise<Run> {
    this.ensureConfigured();

    const response = await this.request(
      RunResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/CancelRun",
      { id: runId, reason }
    );

    return this.mapRunResponse(response);
  }

  /**
   * Retry a failed run
   */
  async retryRun(runId: string, fromStep?: string): Promise<Run> {
    this.ensureConfigured();

    const response = await this.request(
      RunResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/RetryRun",
      { id: runId, fromStep }
    );

    return this.mapRunResponse(response);
  }

  /**
   * Patch a step's output (hot patching)
   */
  async patchStep(
    stepId: string,
    output: Record<string, unknown>,
    reason?: string
  ): Promise<void> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/steps/patch`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ step_id: stepId, output, reason: reason || "" }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Patch step failed: ${response.status}`,
          { code: error?.code || "PATCH_FAILED" }
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Resume a paused or failed run
   */
  async resumeRun(runId: string, fromStep?: string): Promise<Run> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/runs/resume`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ run_id: runId, from_step: fromStep || "" }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Resume run failed: ${response.status}`,
          { code: error?.code || "RESUME_FAILED" }
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Pause a running workflow at the next step boundary (scoped injection).
   */
  async pauseRun(runId: string): Promise<{ status: string }> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.IronflowService/PauseRun`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ run_id: runId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Pause run failed: ${response.status}`,
          { code: error?.code || "PAUSE_FAILED" }
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the paused state of a run, including completed steps and next step hint.
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
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.IronflowService/GetPausedState`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ run_id: runId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get paused state failed: ${response.status}`,
          { code: error?.code || "GET_PAUSED_STATE_FAILED" }
        );
      }

      const data = (await response.json()) as {
        steps: Array<{
          id: string;
          name: string;
          output: string;
          injected: boolean;
          completed_at: string;
        }>;
        next_step_hint: string;
        pause_reason: string;
      };

      return {
        steps: (data.steps || []).map((s) => ({
          id: s.id,
          name: s.name,
          output: s.output ? JSON.parse(s.output) : null,
          injected: s.injected,
          completedAt: s.completed_at,
        })),
        nextStepHint: data.next_step_hint,
        pauseReason: data.pause_reason,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Inject new output for a step in a paused run (scoped injection).
   */
  async injectStepOutput(
    runId: string,
    stepId: string,
    newOutput: unknown,
    reason?: string
  ): Promise<{ stepId: string; previousOutput: unknown }> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.IronflowService/InjectStepOutput`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          run_id: runId,
          step_id: stepId,
          new_output: JSON.stringify(newOutput),
          reason: reason ?? "",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Inject step output failed: ${response.status}`,
          { code: error?.code || "INJECT_FAILED" }
        );
      }

      const data = (await response.json()) as {
        step_id: string;
        previous_output: string;
      };

      return {
        stepId: data.step_id,
        previousOutput: data.previous_output
          ? JSON.parse(data.previous_output)
          : null,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==========================================================================
  // Time-Travel Debugging
  // ==========================================================================

  /**
   * Get the reconstructed state of a run at a specific timestamp.
   */
  async getRunStateAt(runId: string, timestamp: Date): Promise<TimeTravelRunStateSnapshot> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.TimeTravelService/GetRunStateAt`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          runId,
          timestamp: timestamp.toISOString(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get run state failed: ${response.status}`,
          { code: error?.code || "GET_RUN_STATE_FAILED" }
        );
      }

      const data = (await response.json()) as {
        snapshot: {
          runId: string;
          functionId: string;
          status: string;
          input: string;
          steps: Array<{
            stepId: string;
            name: string;
            type: string;
            sequence: number;
            status: string;
            output: string;
            error: string;
            originalOutput: string;
            startedAt: string;
            completedAt: string;
            durationMs: number;
            injected: boolean;
            patched: boolean;
          }>;
          timestamp: string;
          createdAt: string;
        };
      };

      const s = data.snapshot;
      return {
        runId: s.runId,
        functionId: s.functionId,
        status: s.status,
        input: s.input ? JSON.parse(atob(s.input)) : null,
        steps: (s.steps || []).map((step) => ({
          stepId: step.stepId,
          name: step.name,
          type: step.type,
          sequence: step.sequence,
          status: step.status,
          output: step.output ? JSON.parse(atob(step.output)) : null,
          error: step.error ? JSON.parse(atob(step.error)) : null,
          originalOutput: step.originalOutput ? JSON.parse(atob(step.originalOutput)) : null,
          startedAt: step.startedAt ? new Date(step.startedAt) : null,
          completedAt: step.completedAt ? new Date(step.completedAt) : null,
          durationMs: step.durationMs ?? null,
          injected: step.injected,
          patched: step.patched,
        })),
        timestamp: new Date(s.timestamp),
        createdAt: s.createdAt ? new Date(s.createdAt) : null,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the timeline of audit events for a run.
   */
  async getRunTimeline(runId: string): Promise<TimeTravelTimelineEvent[]> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.TimeTravelService/GetRunTimeline`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ runId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get run timeline failed: ${response.status}`,
          { code: error?.code || "GET_TIMELINE_FAILED" }
        );
      }

      const data = (await response.json()) as {
        events: Array<{
          id: string;
          eventType: string;
          stepId: string;
          stepName: string;
          summary: string;
          significant: boolean;
          timestamp: string;
        }>;
      };

      return (data.events || []).map((e) => ({
        id: e.id,
        eventType: e.eventType,
        stepId: e.stepId || "",
        stepName: e.stepName || "",
        summary: e.summary,
        significant: e.significant,
        timestamp: new Date(e.timestamp),
      }));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the output of a specific step at a specific timestamp.
   */
  async getStepOutputAt(
    runId: string,
    stepId: string,
    timestamp: Date
  ): Promise<TimeTravelStepOutputSnapshot> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/ironflow.v1.TimeTravelService/GetStepOutputAt`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          runId,
          stepId,
          timestamp: timestamp.toISOString(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get step output failed: ${response.status}`,
          { code: error?.code || "GET_STEP_OUTPUT_FAILED" }
        );
      }

      const data = (await response.json()) as {
        stepId: string;
        status: string;
        output: string;
        originalOutput: string;
        patched: boolean;
        injected: boolean;
      };

      return {
        stepId: data.stepId,
        status: data.status,
        output: data.output ? JSON.parse(atob(data.output)) : null,
        originalOutput: data.originalOutput ? JSON.parse(atob(data.originalOutput)) : null,
        patched: data.patched,
        injected: data.injected,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List registered functions
   */
  async listFunctions(): Promise<unknown[]> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/functions`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IronflowError(
          `List functions failed: ${response.status}`,
          { code: "LIST_FUNCTIONS_FAILED" }
        );
      }

      const data = await response.json();
      return data.functions || [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List connected workers
   */
  async listWorkers(): Promise<unknown[]> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/workers`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IronflowError(
          `List workers failed: ${response.status}`,
          { code: "LIST_WORKERS_FAILED" }
        );
      }

      const data = await response.json();
      return data.workers || [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string; timestamp: string; version: string }> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/health`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IronflowError(
          `Health check failed: ${response.status}`,
          { code: "HEALTH_FAILED" }
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get server capabilities
   */
  async getCapabilities(): Promise<{ transports: string[]; features: string[]; version: string }> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/capabilities`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IronflowError(
          `Get capabilities failed: ${response.status}`,
          { code: "CAPABILITIES_FAILED" }
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Event Emission
  // ============================================================================

  /**
   * Emit an event
   *
   * @example
   * ```typescript
   * await ironflow.emit('order.approved', {
   *   orderId: '123',
   *   approvedBy: 'user@example.com'
   * });
   * ```
   */
  async emit(
    eventName: string,
    data: unknown,
    options?: EmitOptions
  ): Promise<EmitResult> {
    this.ensureConfigured();

    const response = await this.request(
      TriggerResponseSchema,
      "POST",
      "/ironflow.v1.PubSubService/Emit",
      {
        event: eventName,
        data,
        ...(options?.version ? { version: options.version } : {}),
        idempotency_key: options?.idempotencyKey,
        metadata: options?.metadata,
        namespace: options?.namespace,
      }
    );

    return {
      runIds: response.runIds ?? [],
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
   * const result = await ironflow.emitSync("order.placed", { orderId: "123" });
   * console.log("Output:", result.output);
   * ```
   */
  async emitSync(
    eventName: string,
    data: unknown,
    options?: { timeout?: number }
  ): Promise<EmitSyncResult> {
    this.ensureConfigured();

    const timeout = options?.timeout ?? 30000;

    const response = await this.request(
      TriggerSyncResponseSchema,
      "POST",
      "/ironflow.v1.IronflowService/TriggerSync",
      { event: eventName, data, timeout_ms: timeout }
    );

    const results = response.results;
    if (!results?.length) {
      throw new IronflowError("No results returned from TriggerSync", { code: "NO_RESULTS", retryable: false });
    }

    const result = results[0];
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
  }

  // ============================================================================
  // Consumer Groups
  // ============================================================================

  /**
   * Join a consumer group for load-balanced event processing
   */
  async joinConsumerGroup<T = unknown>(
    groupName: string,
    pattern: string,
    callbacksAndOptions: SubscriptionCallbacks<T> & BrowserSubscribeOptions
  ): Promise<AckableSubscription> {
    this.ensureConfigured();

    const sub = await this.subscribe<T>(pattern, {
      ...callbacksAndOptions,
      consumerGroup: groupName,
      ackMode: "manual",
    });

    return sub as AckableSubscription;
  }

  // ============================================================================
  // Entity Streams
  // ============================================================================

  /**
   * Entity stream operations
   *
   * @example
   * ```typescript
   * // Append an event to a stream
   * const result = await ironflow.streams.append("order-123", {
   *   name: "order.created",
   *   data: { total: 100 },
   *   entityType: "order",
   * });
   *
   * // Read events from a stream
   * const { events } = await ironflow.streams.read("order-123", { limit: 10 });
   *
   * // Get stream info
   * const info = await ironflow.streams.getInfo("order-123");
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
      this.ensureConfigured();

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
      const response = await this.streamRequest<{
        entityVersion: number | string;
        eventId: string;
      }>("/ironflow.v1.EntityStreamService/AppendEvent", body);
      return {
        entityVersion: Number(response.entityVersion ?? 0),
        eventId: response.eventId ?? "",
      };
    },

    /**
     * Read events from an entity stream
     */
    read: async (
      entityId: string,
      options?: ReadStreamOptions
    ): Promise<{ events: StreamEvent[]; totalCount: number }> => {
      this.ensureConfigured();

      const response = await this.streamRequest<{
        events?: Array<{
          id: string;
          name: string;
          data?: Record<string, unknown>;
          entityVersion: number | string;
          version: number;
          timestamp: string;
          source?: string;
          metadata?: Record<string, unknown>;
        }>;
        totalCount?: number | string;
      }>("/ironflow.v1.EntityStreamService/ReadStream", {
        entity_id: entityId,
        from_version: options?.fromVersion ?? 0,
        limit: options?.limit ?? 0,
        direction: options?.direction ?? "forward",
      });
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
        totalCount: Number(response.totalCount ?? 0),
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
     * const info = await ironflow.streams.getInfo("order-123");
     * await ironflow.streams.append("order-123", event, {
     *   expectedVersion: info ? info.version : 0,
     * });
     * ```
     */
    getInfo: async (entityId: string): Promise<StreamInfo | null> => {
      this.ensureConfigured();

      try {
        const response = await this.streamRequest<{
          entityId: string;
          entityType: string;
          version: number | string;
          eventCount: number | string;
          createdAt: string;
          updatedAt: string;
        }>("/ironflow.v1.EntityStreamService/GetStreamInfo", {
          entity_id: entityId,
        });
        return {
          entityId: response.entityId ?? "",
          entityType: response.entityType ?? "",
          version: Number(response.version ?? 0),
          eventCount: Number(response.eventCount ?? 0),
          createdAt: response.createdAt ?? "",
          updatedAt: response.updatedAt ?? "",
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
     */
    createSnapshot: async (
      entityId: string,
      input: {
        entityType: string;
        entityVersion: number;
        state: Record<string, unknown>;
      }
    ): Promise<{ snapshotId: string }> => {
      this.ensureConfigured();

      const response = await this.streamRequest<{
        snapshotId: string;
      }>("/ironflow.v1.EntityStreamService/CreateSnapshot", {
        entity_id: entityId,
        entity_type: input.entityType,
        entity_version: input.entityVersion,
        state: input.state,
      });
      return { snapshotId: response.snapshotId ?? "" };
    },

    /**
     * Get the latest snapshot at or before a given version.
     */
    getSnapshot: async (
      entityId: string,
      options?: { beforeVersion?: number }
    ): Promise<StreamSnapshot> => {
      this.ensureConfigured();

      const response = await this.streamRequest<{
        snapshotId: string;
        entityId: string;
        entityType: string;
        entityVersion: number | string;
        state: Record<string, unknown>;
        createdAt: string;
      }>("/ironflow.v1.EntityStreamService/GetSnapshot", {
        entity_id: entityId,
        before_version: options?.beforeVersion ?? 0,
      });
      return {
        snapshotId: response.snapshotId ?? "",
        entityId: response.entityId ?? "",
        entityType: response.entityType ?? "",
        entityVersion: Number(response.entityVersion ?? 0),
        state: response.state ?? {},
        createdAt: response.createdAt ?? "",
      };
    },

    /**
     * Subscribe to real-time events for an entity stream
     *
     * @example
     * ```typescript
     * const sub = await ironflow.streams.subscribe("order-123", {
     *   entityType: "order",
     *   onEvent: (event) => console.log(event),
     *   replay: 100,
     * });
     *
     * // Cleanup
     * sub.unsubscribe();
     * ```
     */
    subscribe: async (
      entityId: string,
      options: EntitySubscribeOptions
    ): Promise<Subscription> => {
      this.ensureConfigured();

      const pattern = `entity:${options.entityType}.${entityId}.>`;

      const sub = await this.subscribe<StreamEvent>(pattern, {
        onEvent: (event) => {
          const data = event.data as unknown as Record<string, unknown>;
          const streamEvent: StreamEvent = {
            id: (data.id as string) ?? "",
            name: (data.name as string) ?? "",
            data: (data.data as Record<string, unknown>) ?? {},
            entityVersion: (data.entityVersion as number) ?? 0,
            version: (data.version as number) ?? 0,
            timestamp: (data.timestamp as string) ?? "",
            source: data.source as string | undefined,
            metadata: data.metadata as Record<string, unknown> | undefined,
          };
          options.onEvent(streamEvent);
        },
        onError: options.onError
          ? (info) => options.onError!(new Error(info.message))
          : undefined,
        replay: options.replay,
      });

      return sub as Subscription;
    },
  };

  // ============================================================================
  // Projections
  // ============================================================================

  /**
   * Get the current state of a projection
   *
   * @example
   * ```typescript
   * const result = await ironflow.getProjection<OrderStats>('order-stats');
   * console.log(result.state); // { totalOrders: 42, ... }
   *
   * // With partition
   * const result = await ironflow.getProjection('order-stats', { partition: 'customer-123' });
   * ```
   */
  async getProjection<TState = unknown>(
    name: string,
    options?: GetProjectionOptions
  ): Promise<ProjectionStateResult<TState>> {
    this.ensureConfigured();

    // Normalize empty-string partition to undefined so peel falls back to
    // "__global__" instead of returning empty-string partition.
    const partition = options?.partition ? options.partition : undefined;
    let url = `${this.config!.serverUrl}/api/v1/projections/${encodeURIComponent(name)}`;
    if (partition) {
      url += `?partition=${encodeURIComponent(partition)}`;
    }

    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get projection failed: ${response.status}`,
          { code: error?.code || "GET_PROJECTION_FAILED" }
        );
      }

      const data = await response.json();
      return peelProjectionEnvelope<TState>(data, partition);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Query a SQL-backed projection table with optional filtering, ordering, and pagination.
   *
   * @example
   * ```typescript
   * const result = await ironflow.querySQLProjection('board', {
   *   where: "status = 'OPEN'",
   *   orderBy: "title ASC",
   *   limit: 50,
   * });
   * ```
   */
  async querySQLProjection(
    name: string,
    options?: QuerySQLProjectionOptions
  ): Promise<SQLProjectionQueryResult> {
    this.ensureConfigured();

    const response = await this.streamRequest<{
      columns: string[];
      rows?: Array<{ values: string[] }>;
      totalCount: number | string;
    }>("/ironflow.v1.ProjectionService/QuerySQLProjection", {
      name,
      where: options?.where ?? "",
      order_by: options?.orderBy ?? "",
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
    });

    return {
      columns: response.columns ?? [],
      rows: (response.rows ?? []).map((r) => r.values),
      totalCount: Number(response.totalCount ?? 0),
    };
  }

  /**
   * Get the status of a projection
   *
   * @example
   * ```typescript
   * const status = await ironflow.getProjectionStatus('order-stats');
   * console.log(status.status); // 'active' | 'rebuilding' | 'paused' | 'error'
   * ```
   */
  async getProjectionStatus(name: string): Promise<ProjectionStatusInfo> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/projections/${encodeURIComponent(name)}/status`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Get projection status failed: ${response.status}`,
          { code: error?.code || "GET_PROJECTION_STATUS_FAILED" }
        );
      }

      const data = await response.json();

      return {
        name: data.name,
        status: data.status,
        mode: data.mode,
        lastEventSeq: data.last_event_seq ?? 0,
        lag: data.lag ?? 0,
        errorMessage: data.error_message || undefined,
        updatedAt: data.updated_at ? new Date(data.updated_at) : new Date(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Trigger a rebuild of a projection
   *
   * @example
   * ```typescript
   * const result = await ironflow.rebuildProjection('order-stats');
   * ```
   */
  async rebuildProjection(
    name: string,
    options?: RebuildProjectionOptions
  ): Promise<{ status: string }> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/projections/${encodeURIComponent(name)}/rebuild`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          partition: options?.partition,
          from_event_id: options?.fromEventId,
          dry_run: options?.dryRun,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Rebuild projection failed: ${response.status}`,
          { code: error?.code || "REBUILD_PROJECTION_FAILED" }
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Wait until the named projection has processed events up to `minSeq`,
   * or the timeout elapses. Read-your-writes primitive for CQRS UIs:
   * pair with `sequence` from an `appendEntityEvent` response.
   *
   * Issue #473.
   */
  async waitForProjectionCatchup(
    name: string,
    opts: { minSeq: number | bigint; timeoutMs?: number; partition?: string }
  ): Promise<WaitResult> {
    this.ensureConfigured();
    const params = new URLSearchParams();
    params.set("minSeq", String(opts.minSeq));
    if (opts.timeoutMs !== undefined) params.set("timeout", String(opts.timeoutMs));
    if (opts.partition) params.set("partition", opts.partition);

    const url = `${this.config!.serverUrl}/api/v1/projections/${encodeURIComponent(name)}/catchup?${params.toString()}`;
    // The wait timeout may exceed the normal client timeout — use the
    // opts.timeoutMs (plus a small grace period) so the client doesn't
    // abort the request before the server gets a chance to time out.
    const clientTimeoutMs = (opts.timeoutMs ?? 30_000) + 2_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), clientTimeoutMs);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Wait for projection catchup failed: ${response.status}`,
          { code: error?.code || "WAIT_FOR_PROJECTION_FAILED" }
        );
      }
      return (await response.json()) as WaitResult;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Streaming wait for a projection to catch up to `minSeq` (issue #476).
   *
   * Returns an `AsyncIterable<WaitProgress>` that yields a frame each time
   * the projection cursor advances, plus one terminal frame (`terminal:
   * true`) on catch-up, timeout, or error, after which iteration ends.
   * Heartbeats are filtered inside the SDK — callers never see them.
   *
   * Unlike the unary `waitForProjectionCatchup`, this path uses a
   * server-streaming ConnectRPC connection. The server caps the wait at
   * 300s regardless of `timeoutMs`. Pass `opts.signal` to cancel early
   * (e.g., on React unmount); breaking out of `for await` also aborts
   * the stream.
   *
   * Example:
   * ```ts
   * for await (const p of ironflow.waitForProjectionCatchupStream("order-view", { minSeq: 42 })) {
   *   if (p.terminal) {
   *     if (p.caughtUp) return;
   *     throw new Error(`wait failed: timedOut=${p.timedOut} error=${p.error}`);
   *   }
   *   console.log(`progress: ${p.currentSeq}/${p.targetSeq} behind=${p.behindByEvents}`);
   * }
   * ```
   */
  async *waitForProjectionCatchupStream(
    name: string,
    opts: {
      minSeq: number | bigint;
      timeoutMs?: number;
      partition?: string;
      signal?: AbortSignal;
    }
  ): AsyncIterable<WaitProgress> {
    this.ensureConfigured();
    // Lazy-load the generated projection client deps only when someone
    // actually calls the streaming API — keeps the tree-shaken bundle small
    // for apps that only use the unary wait.
    const { createClient } = await import("@connectrpc/connect");
    const { createConnectTransport } = await import("@connectrpc/connect-web");
    const { create } = await import("@bufbuild/protobuf");
    const { ProjectionService, WaitProjectionCatchupRequestSchema, WaitStreamFrameKind } =
      await import("@ironflow/core/gen");

    const transport = createConnectTransport({
      baseUrl: this.config!.serverUrl,
      interceptors: [
        (next) => async (req) => {
          req.header.set(HEADERS.ENVIRONMENT, this.config!.environment);
          const token = this.config!.auth?.apiKey || this.config!.auth?.token;
          if (token) req.header.set("Authorization", `Bearer ${token}`);
          return next(req);
        },
      ],
    });
    const client = createClient(ProjectionService, transport);

    const request = create(WaitProjectionCatchupRequestSchema, {
      name,
      minSeq: typeof opts.minSeq === "bigint" ? opts.minSeq : BigInt(opts.minSeq),
      partition: opts.partition ?? "",
      timeout:
        opts.timeoutMs !== undefined
          ? {
              $typeName: "google.protobuf.Duration",
              seconds: BigInt(Math.floor(opts.timeoutMs / 1000)),
              nanos: (opts.timeoutMs % 1000) * 1_000_000,
            }
          : undefined,
    });

    const stream = client.waitProjectionCatchupStream(request, { signal: opts.signal });
    yield* filterWaitStreamFrames(stream, WaitStreamFrameKind);
  }

  /**
   * Wait for a specific event to be processed by the given projection.
   * The server resolves `eventId` to its NATS sequence internally.
   *
   * Issue #473.
   */
  async waitForEvent(
    eventId: string,
    projection: string,
    opts: { timeoutMs?: number; partition?: string } = {}
  ): Promise<WaitResult> {
    this.ensureConfigured();
    const url = `${this.config!.serverUrl}/api/v1/projections/wait-for-event`;
    const clientTimeoutMs = (opts.timeoutMs ?? 30_000) + 2_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), clientTimeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }
      const body: Record<string, unknown> = { eventId, projection };
      if (opts.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs;
      if (opts.partition) body.partition = opts.partition;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          error?.message || `Wait for event failed: ${response.status}`,
          { code: error?.code || "WAIT_FOR_EVENT_FAILED" }
        );
      }
      return (await response.json()) as WaitResult;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List all registered projections
   *
   * @example
   * ```typescript
   * const projections = await ironflow.listProjections();
   * projections.forEach(p => console.log(p.name, p.status));
   * ```
   */
  async listProjections(): Promise<ProjectionStatusInfo[]> {
    this.ensureConfigured();

    const url = `${this.config!.serverUrl}/api/v1/projections`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };
      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IronflowError(
          `List projections failed: ${response.status}`,
          { code: "LIST_PROJECTIONS_FAILED" }
        );
      }

      const data = await response.json();
      const projections = data.projections || [];

      return projections.map((p: Record<string, unknown>) => ({
        name: p.name as string,
        status: p.status as ProjectionStatusInfo["status"],
        mode: p.mode as ProjectionStatusInfo["mode"],
        lastEventSeq: (p.last_event_seq as number) ?? 0,
        lag: 0,
        errorMessage: (p.error_message as string) || undefined,
        updatedAt: p.updated_at ? new Date(p.updated_at as string) : new Date(),
      }));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Subscribe to real-time updates for a projection
   *
   * @example
   * ```typescript
   * const sub = await ironflow.subscribeToProjection<OrderStats>('order-stats', {
   *   onUpdate: (state, event) => console.log('Updated:', state),
   *   onError: (error) => console.error(error),
   * });
   *
   * // With partition
   * const sub = await ironflow.subscribeToProjection('order-stats', {
   *   onUpdate: (state, event) => console.log('Updated:', state),
   * }, { partition: 'customer-123' });
   *
   * // Cleanup
   * sub.unsubscribe();
   * ```
   */
  async subscribeToProjection<TState = unknown>(
    name: string,
    callbacks: ProjectionSubscriptionCallbacks<TState>,
    options?: { partition?: string; replay?: number }
  ): Promise<Subscription> {
    this.ensureConfigured();

    // Build the subscription pattern
    let pattern: string;
    if (options?.partition) {
      pattern = `system.projection.${name}.${options.partition}.updated`;
    } else {
      pattern = `system.projection.${name}.>`;
    }

    const sub = await this.subscribe(pattern, {
      onEvent: (event) => {
        const payload = event.data as unknown as Record<string, unknown>;
        const state = (payload.state as TState) ?? ({} as TState);
        callbacks.onUpdate(state, {
          id: (payload.last_event_id as string) ?? "",
          name: (payload.last_event_name as string) ?? "",
        });
      },
      onError: callbacks.onError
        ? (info) => callbacks.onError!(new Error(info.message))
        : undefined,
      replay: options?.replay,
    });

    return sub as Subscription;
  }

  // ============================================================================
  // KV Store
  // ============================================================================

  /**
   * KV store operations
   *
   * @example
   * ```typescript
   * const kv = ironflow.kv();
   * const bucket = await kv.createBucket({ name: "sessions", ttlSeconds: 3600 });
   * const handle = kv.bucket("sessions");
   * const { revision } = await handle.put("user.123", { token: "abc" });
   * const entry = await handle.get("user.123");
   *
   * // Watch for changes
   * const watcher = handle.watch({
   *   onUpdate: (event) => console.log(event),
   * }, { key: "user.*" });
   * ```
   */
  kv(): BrowserKVClient {
    this.ensureConfigured();
    return new BrowserKVClient(this.config!);
  }

  // ============================================================================
  // Config Management
  // ============================================================================

  /**
   * Config management operations
   *
   * @example
   * ```typescript
   * const cfg = ironflow.configManager();
   * await cfg.set("app", { featureX: true, maxRetries: 3 });
   * const { data, revision } = await cfg.get("app");
   * await cfg.patch("app", { maxRetries: 5 });
   * const configs = await cfg.list();
   * await cfg.delete("app");
   *
   * // Watch for changes
   * const sub = await cfg.watch("app", {
   *   onEvent: (config) => console.log(config),
   * });
   * sub.unsubscribe();
   * ```
   */
  configManager(): BrowserConfigClient {
    this.ensureConfigured();
    return new BrowserConfigClient(this.config!, (pattern, callbacks) =>
      this.subscribe(pattern, callbacks)
    );
  }

  // ============================================================================
  // Auth Management
  // ============================================================================

  /**
   * API key management operations
   *
   * @example
   * ```typescript
   * // Create an API key
   * const key = await ironflow.apiKeys.create({ name: "my-key" });
   * console.log(key.key); // Only shown once
   *
   * // List API keys
   * const keys = await ironflow.apiKeys.list();
   *
   * // Delete an API key
   * await ironflow.apiKeys.delete(key.id);
   * ```
   */
  readonly apiKeys = {
    /**
     * Create a new API key
     */
    create: async (input: CreateAPIKeyInput): Promise<APIKeyWithSecret> => {
      this.ensureConfigured();
      return this.restRequest<APIKeyWithSecret>("POST", "/api/v1/apikeys", input);
    },

    /**
     * List all API keys
     */
    list: async (): Promise<APIKey[]> => {
      this.ensureConfigured();
      return this.restRequest<APIKey[]>("GET", "/api/v1/apikeys");
    },

    /**
     * Get an API key by ID
     */
    get: async (id: string): Promise<APIKey> => {
      this.ensureConfigured();
      return this.restRequest<APIKey>("GET", `/api/v1/apikeys/${encodeURIComponent(id)}`);
    },

    /**
     * Delete an API key
     */
    delete: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/apikeys/${encodeURIComponent(id)}`);
    },

    /**
     * Rotate an API key, returning a new secret
     */
    rotate: async (id: string): Promise<APIKeyWithSecret> => {
      this.ensureConfigured();
      return this.restRequest<APIKeyWithSecret>(
        "POST",
        `/api/v1/apikeys/${encodeURIComponent(id)}/rotate`
      );
    },
  };

  /**
   * Organization management operations (enterprise-only)
   *
   * @example
   * ```typescript
   * // Create an organization
   * const org = await ironflow.orgs.create({ name: "Acme Corp" });
   *
   * // List organizations
   * const orgs = await ironflow.orgs.list();
   *
   * // Update an organization
   * await ironflow.orgs.update(org.id, { name: "Acme Inc" });
   * ```
   */
  readonly orgs = {
    /**
     * Create a new organization
     */
    create: async (input: CreateOrgInput): Promise<Organization> => {
      this.ensureConfigured();
      return this.restRequest<Organization>("POST", "/api/v1/orgs", input);
    },

    /**
     * List all organizations
     */
    list: async (): Promise<Organization[]> => {
      this.ensureConfigured();
      return this.restRequest<Organization[]>("GET", "/api/v1/orgs");
    },

    /**
     * Get an organization by ID
     */
    get: async (id: string): Promise<Organization> => {
      this.ensureConfigured();
      return this.restRequest<Organization>("GET", `/api/v1/orgs/${encodeURIComponent(id)}`);
    },

    /**
     * Update an organization
     */
    update: async (id: string, input: UpdateOrgInput): Promise<Organization> => {
      this.ensureConfigured();
      return this.restRequest<Organization>(
        "PATCH",
        `/api/v1/orgs/${encodeURIComponent(id)}`,
        input
      );
    },

    /**
     * Delete an organization
     */
    delete: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/orgs/${encodeURIComponent(id)}`);
    },
  };

  /**
   * Role management operations (enterprise-only)
   *
   * @example
   * ```typescript
   * // Create a role
   * const role = await ironflow.roles.create({ name: "editor", org_id: "org-1" });
   *
   * // Assign a policy to the role
   * await ironflow.roles.assignPolicy(role.id, policyId);
   *
   * // List roles
   * const roles = await ironflow.roles.list();
   * ```
   */
  readonly roles = {
    /**
     * Create a new role
     */
    create: async (input: CreateRoleInput): Promise<Role> => {
      this.ensureConfigured();
      return this.restRequest<Role>("POST", "/api/v1/roles", input);
    },

    /**
     * List all roles
     */
    list: async (orgId?: string): Promise<Role[]> => {
      this.ensureConfigured();
      const query = orgId ? `?org_id=${encodeURIComponent(orgId)}` : "";
      return this.restRequest<Role[]>("GET", `/api/v1/roles${query}`);
    },

    /**
     * Get a role by ID
     */
    get: async (id: string): Promise<Role> => {
      this.ensureConfigured();
      return this.restRequest<Role>("GET", `/api/v1/roles/${encodeURIComponent(id)}`);
    },

    /**
     * Update a role
     */
    update: async (id: string, input: UpdateRoleInput): Promise<Role> => {
      this.ensureConfigured();
      return this.restRequest<Role>(
        "PATCH",
        `/api/v1/roles/${encodeURIComponent(id)}`,
        input
      );
    },

    /**
     * Delete a role
     */
    delete: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/roles/${encodeURIComponent(id)}`);
    },

    /**
     * Assign a policy to a role
     */
    assignPolicy: async (roleId: string, policyId: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>(
        "POST",
        `/api/v1/roles/${encodeURIComponent(roleId)}/policies`,
        { policy_id: policyId }
      );
    },

    /**
     * Remove a policy from a role
     */
    removePolicy: async (roleId: string, policyId: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>(
        "DELETE",
        `/api/v1/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`
      );
    },
  };

  /**
   * Policy management operations (enterprise-only)
   *
   * @example
   * ```typescript
   * // Create a deny policy (#943: effect="allow" is rejected at write).
   * const policy = await ironflow.policies.create({
   *   name: "deny-prod-delete",
   *   effect: "deny",
   *   actions: "delete",
   *   resources: "irn:*:prod:*",
   *   condition: 'request.environment == "production"',
   *   org_id: "org-1",
   * });
   *
   * // List policies
   * const policies = await ironflow.policies.list();
   * ```
   */
  readonly policies = {
    /**
     * Create a new policy
     */
    create: async (input: CreatePolicyInput): Promise<Policy> => {
      this.ensureConfigured();
      return this.restRequest<Policy>("POST", "/api/v1/policies", input);
    },

    /**
     * List all policies
     */
    list: async (orgId?: string): Promise<Policy[]> => {
      this.ensureConfigured();
      const query = orgId ? `?org_id=${encodeURIComponent(orgId)}` : "";
      return this.restRequest<Policy[]>("GET", `/api/v1/policies${query}`);
    },

    /**
     * Get a policy by ID
     */
    get: async (id: string): Promise<Policy> => {
      this.ensureConfigured();
      return this.restRequest<Policy>("GET", `/api/v1/policies/${encodeURIComponent(id)}`);
    },

    /**
     * Update a policy
     */
    update: async (id: string, input: UpdatePolicyInput): Promise<Policy> => {
      this.ensureConfigured();
      return this.restRequest<Policy>(
        "PATCH",
        `/api/v1/policies/${encodeURIComponent(id)}`,
        input
      );
    },

    /**
     * Delete a policy
     */
    delete: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/policies/${encodeURIComponent(id)}`);
    },
  };

  /**
   * Event schema registry operations
   *
   * @example
   * ```typescript
   * // Register a schema
   * const schema = await ironflow.schemas.register({
   *   name: "order.placed",
   *   version: 1,
   *   schema: { type: "object", properties: { orderId: { type: "string" } } },
   * });
   *
   * // List all schemas
   * const schemas = await ironflow.schemas.list();
   *
   * // Get latest version of a schema
   * const latest = await ironflow.schemas.get("order.placed");
   *
   * // Test an upcast transformation
   * const result = await ironflow.schemas.testUpcast({
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
      this.ensureConfigured();
      return this.restRequest<EventSchema>("POST", "/api/v1/events/schemas", {
        event_name: input.name,
        version: input.version,
        schema_json: JSON.stringify(input.schema),
      });
    },
    /** List all registered event schemas */
    list: async (): Promise<EventSchema[]> => {
      this.ensureConfigured();
      const resp = await this.restRequest<{ schemas: EventSchema[] }>("GET", "/api/v1/events/schemas");
      return resp.schemas ?? [];
    },
    /** Get the latest version of an event schema by name */
    get: async (name: string): Promise<EventSchema> => {
      this.ensureConfigured();
      return this.restRequest<EventSchema>("GET", `/api/v1/events/schemas/${encodeURIComponent(name)}`);
    },
    /** Get a specific version of an event schema */
    getVersion: async (name: string, version: number): Promise<EventSchema> => {
      this.ensureConfigured();
      return this.restRequest<EventSchema>("GET", `/api/v1/events/schemas/${encodeURIComponent(name)}/${version}`);
    },
    /** Delete a specific version of an event schema */
    delete: async (name: string, version: number): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/events/schemas/${encodeURIComponent(name)}/${version}`);
    },
    /** Test an upcast transformation between two schema versions */
    testUpcast: async (input: TestUpcastInput): Promise<UpcastResult> => {
      this.ensureConfigured();
      return this.restRequest<UpcastResult>("POST", "/api/v1/events/upcast", input);
    },
  };

  // ============================================================================
  // Audit Trail
  // ============================================================================

  /**
   * Get the audit trail for a run.
   *
   * @param runId The run ID to retrieve the audit trail for
   * @param options Optional filtering options
   *
   * @example
   * ```typescript
   * const result = await ironflow.getAuditTrail("run-abc123");
   * for (const event of result.events) {
   *   console.log(event.eventType, event.createdAt);
   * }
   * ```
   */
  async getAuditTrail(runId: string, options?: GetAuditTrailOptions): Promise<AuditTrailResult> {
    this.ensureConfigured();

    const response = await this.streamRequest<{
      events?: Array<{
        id: string;
        run_id: string;
        function_id: string;
        step_id?: string;
        event_type: string;
        payload?: Record<string, unknown>;
        metadata?: Record<string, string>;
        created_at: string;
      }>;
      total_count?: number;
      next_cursor?: string;
    }>("/ironflow.v1.AuditService/GetAuditTrail", {
      run_id: runId,
      event_type: options?.eventType ?? "",
      from_timestamp: options?.fromTimestamp ?? "",
      to_timestamp: options?.toTimestamp ?? "",
      limit: options?.limit ?? 0,
      cursor: options?.cursor ?? "",
    });

    return {
      events: (response.events ?? []).map((e): AuditEvent => ({
        id: e.id,
        runId: e.run_id,
        functionId: e.function_id,
        stepId: e.step_id,
        eventType: e.event_type,
        payload: e.payload ?? {},
        metadata: e.metadata,
        createdAt: e.created_at,
      })),
      totalCount: response.total_count ?? 0,
      nextCursor: response.next_cursor,
    };
  }

  // ============================================================================
  // Webhook Management
  // ============================================================================

  /**
   * Webhook management operations
   *
   * @example
   * ```typescript
   * // List all webhook sources
   * const sources = await ironflow.webhooks.listSources();
   *
   * // Delete a webhook source
   * await ironflow.webhooks.deleteSource("my-webhook");
   *
   * // List deliveries
   * const { deliveries } = await ironflow.webhooks.listDeliveries({ sourceId: "my-webhook" });
   * ```
   */
  readonly webhooks = {
    /** Create a new webhook source */
    create: async (input: CreateWebhookSourceInput): Promise<WebhookSource> => {
      this.ensureConfigured();
      const response = await this.streamRequest<{
        id: string;
        event_prefix: string;
        verify_header?: string;
        verify_algorithm?: string;
        source_type?: string;
        metadata?: Record<string, unknown>;
        created_at?: string;
        updated_at?: string;
      }>("/ironflow.v1.WebhookService/CreateWebhookSource", {
        id: input.id,
        event_prefix: input.eventPrefix,
        verify_header: input.verifyHeader ?? "",
        verify_algorithm: input.verifyAlgorithm ?? "",
        verify_secret: input.verifySecret ?? "",
        metadata: input.metadata,
      });
      return {
        id: response.id,
        eventPrefix: response.event_prefix,
        verifyHeader: response.verify_header,
        verifyAlgorithm: response.verify_algorithm,
        sourceType: response.source_type,
        metadata: response.metadata,
        createdAt: response.created_at,
        updatedAt: response.updated_at,
      };
    },

    /** List all registered webhook sources */
    listSources: async (): Promise<WebhookSource[]> => {
      this.ensureConfigured();
      const response = await this.streamRequest<{
        sources?: Array<{
          id: string;
          event_prefix: string;
          verify_header?: string;
          verify_algorithm?: string;
          source_type?: string;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        }>;
      }>("/ironflow.v1.WebhookService/ListWebhookSources", { limit: 0, offset: 0 });
      return (response.sources ?? []).map((s) => ({
        id: s.id,
        eventPrefix: s.event_prefix,
        verifyHeader: s.verify_header,
        verifyAlgorithm: s.verify_algorithm,
        sourceType: s.source_type,
        metadata: s.metadata,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }));
    },

    /** Delete a webhook source by ID */
    deleteSource: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.streamRequest<Record<string, never>>(
        "/ironflow.v1.WebhookService/DeleteWebhookSource",
        { id }
      );
    },

    /** List webhook deliveries with optional filtering */
    listDeliveries: async (opts?: ListWebhookDeliveriesOptions): Promise<{
      deliveries: WebhookDelivery[];
      totalCount: number;
    }> => {
      this.ensureConfigured();
      const response = await this.streamRequest<{
        deliveries?: Array<{
          id: string;
          source_id: string;
          external_id?: string;
          status: string;
          event_id?: string;
          error?: string;
          created_at?: string;
        }>;
        total_count?: number;
      }>("/ironflow.v1.WebhookService/ListWebhookDeliveries", {
        source_id: opts?.sourceId ?? "",
        status: opts?.status ?? "",
        limit: opts?.limit ?? 0,
        offset: opts?.offset ?? 0,
      });
      return {
        deliveries: (response.deliveries ?? []).map((d) => ({
          id: d.id,
          sourceId: d.source_id,
          externalId: d.external_id,
          status: d.status,
          eventId: d.event_id,
          error: d.error,
          createdAt: d.created_at,
        })),
        totalCount: response.total_count ?? 0,
      };
    },
  };

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * User management operations
   *
   * @example
   * ```typescript
   * // List all users
   * const users = await ironflow.users.list();
   *
   * // Create a user
   * const user = await ironflow.users.create({
   *   email: "alice@example.com",
   *   password: "secret",
   *   roles: ["admin"],
   * });
   *
   * // Update a user
   * await ironflow.users.update(user.id, { name: "Alice" });
   * ```
   */
  readonly users = {
    /** Create a new user (admin only) */
    create: async (input: CreateUserInput): Promise<User> => {
      this.ensureConfigured();
      return this.restRequest<User>("POST", "/api/v1/users", input);
    },

    /** List all users in the current organization (admin only) */
    list: async (): Promise<User[]> => {
      this.ensureConfigured();
      return this.restRequest<User[]>("GET", "/api/v1/users");
    },

    /** Get a user by ID */
    get: async (id: string): Promise<User> => {
      this.ensureConfigured();
      return this.restRequest<User>("GET", `/api/v1/users/${encodeURIComponent(id)}`);
    },

    /** Update a user's profile (admin only) */
    update: async (id: string, input: UpdateUserInput): Promise<User> => {
      this.ensureConfigured();
      return this.restRequest<User>("PATCH", `/api/v1/users/${encodeURIComponent(id)}`, input);
    },

    /** Delete a user (admin only) */
    delete: async (id: string): Promise<void> => {
      this.ensureConfigured();
      await this.restRequest<void>("DELETE", `/api/v1/users/${encodeURIComponent(id)}`);
    },
  };

  /**
   * Tenant management operations (enterprise-only)
   *
   * @example
   * ```typescript
   * // List all tenants
   * const tenants = await ironflow.tenants.list();
   * ```
   */
  readonly tenants = {
    /** List all tenants (enterprise-only) */
    list: async (): Promise<Tenant[]> => {
      this.ensureConfigured();
      return this.restRequest<Tenant[]>("GET", "/api/v1/tenants");
    },
  };

  // ============================================================================
  // Pattern Helpers (static)
  // ============================================================================

  /**
   * Pattern helpers for building subscription patterns
   */
  static patterns = patterns;

  // ============================================================================
  // Internal Methods
  // ============================================================================

  private ensureConfigured(): void {
    if (!this.config) {
      throw new NotConfiguredError();
    }
  }

  private cleanup(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.subscriptionManager) {
      this.subscriptionManager.disconnect();
      this.subscriptionManager = null;
    }

    this.transport = null;
  }

  /**
   * Reset client state for testing. Not intended for production use.
   * @internal
   */
  _resetForTesting(): void {
    this.cleanup();
    this.config = null;
    this.logger = createNoopLogger();
  }

  private setupVisibilityHandling(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.logger.debug("Tab hidden, pausing subscriptions");
        this.subscriptionManager?.pause();
      } else {
        if (this.config?.visibility.reconnectOnVisible) {
          this.logger.debug("Tab visible, resuming subscriptions");
          this.subscriptionManager?.resume();
        }
      }
    };

    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private async request<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body: unknown
  ): Promise<T> {
    const url = `${this.config!.serverUrl}${path}`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };

      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      } else if (this.config!.auth?.token) {
        headers["Authorization"] = `Bearer ${this.config!.auth.token}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const responseBody = await response.text();

      if (!response.ok) {
        const errorResult = ErrorResponseSchema.safeParse(
          safeJsonParse(responseBody)
        );
        const errorData = errorResult.success
          ? errorResult.data
          : { message: responseBody };

        throw new IronflowError(
          errorData.message ?? `Request failed: ${response.status}`,
          {
            code: errorData.code ?? `HTTP_${response.status}`,
            retryable: response.status >= 500,
          }
        );
      }

      const parsed = safeJsonParse(responseBody);
      if (parsed === undefined) {
        throw new ValidationError("Invalid JSON response from server");
      }

      const result = schema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ");
        throw new ValidationError(`Invalid response from server: ${issues}`);
      }

      return result.data;
    } catch (error) {
      if (error instanceof IronflowError || error instanceof ValidationError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(
          `Request timeout after ${timeout}ms for ${method} ${path}`,
          {
            code: "TIMEOUT",
            retryable: true,
          }
        );
      }

      throw new IronflowError(
        error instanceof Error
          ? `${method} ${path} failed: ${error.message}`
          : `${method} ${path} failed`,
        {
          code: "REQUEST_FAILED",
          retryable: true,
          cause: error instanceof Error ? error : undefined,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async streamRequest<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config!.serverUrl}${path}`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };

      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      } else if (this.config!.auth?.token) {
        headers["Authorization"] = `Bearer ${this.config!.auth.token}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = safeJsonParse(await response.text()) as
          | { message?: string; code?: string }
          | undefined;
        throw new IronflowError(
          errorBody?.message ?? `Request failed: ${response.status}`,
          {
            code: errorBody?.code ?? `HTTP_${response.status}`,
            retryable: response.status >= 500,
          }
        );
      }

      return response.json();
    } catch (error) {
      if (error instanceof IronflowError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(
          `Request timeout after ${timeout}ms for POST ${path}`,
          { code: "TIMEOUT", retryable: true }
        );
      }

      throw new IronflowError(
        error instanceof Error
          ? `POST ${path} failed: ${error.message}`
          : `POST ${path} failed`,
        {
          code: "REQUEST_FAILED",
          retryable: true,
          cause: error instanceof Error ? error : undefined,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * REST request helper for auth management endpoints.
   *
   * Supports GET, POST, PATCH, DELETE methods with typed error mapping:
   * - 401 → UnauthenticatedError
   * - 402 → EnterpriseRequiredError
   * - 403 → UnauthorizedError
   */
  private async restRequest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config!.serverUrl}${path}`;
    const timeout = this.config!.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config!.environment,
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (this.config!.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config!.auth.apiKey}`;
      } else if (this.config!.auth?.token) {
        headers["Authorization"] = `Bearer ${this.config!.auth.token}`;
      }

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Request failed with status ${response.status}`;
        if (errorText) {
          const errorJson = safeJsonParse(errorText) as
            | { message?: string; code?: string }
            | undefined;
          if (errorJson?.message) {
            errorMessage = errorJson.message;
          } else if (errorText) {
            errorMessage = errorText;
          }
        }

        switch (response.status) {
          case 401:
            throw new UnauthenticatedError(errorMessage);
          case 402:
            throw new EnterpriseRequiredError(errorMessage);
          case 403:
            throw new UnauthorizedError(errorMessage);
          default:
            throw new IronflowError(errorMessage, {
              code: `HTTP_${response.status}`,
              retryable: response.status >= 500,
            });
        }
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (
        error instanceof IronflowError ||
        error instanceof UnauthenticatedError ||
        error instanceof EnterpriseRequiredError ||
        error instanceof UnauthorizedError
      ) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(
          `Request timeout after ${timeout}ms for ${method} ${path}`,
          { code: "TIMEOUT", retryable: true }
        );
      }

      throw new IronflowError(
        error instanceof Error
          ? `${method} ${path} failed: ${error.message}`
          : `${method} ${path} failed`,
        {
          code: "REQUEST_FAILED",
          retryable: true,
          cause: error instanceof Error ? error : undefined,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapRunResponse(response: z.infer<typeof RunResponseSchema>): Run {
    // ConnectRPC returns proto enum strings like "RUN_STATUS_COMPLETED" — normalize to "completed"
    const rawStatus = response.status.toLowerCase().replace(/^run_status_/, "");
    const statusResult = RunStatusSchema.safeParse(rawStatus);
    const status: RunStatus = statusResult.success ? statusResult.data : "failed";

    return {
      id: response.id,
      functionId: response.functionId,
      eventId: response.eventId,
      status,
      attempt: response.attempt,
      maxAttempts: response.maxAttempts,
      input: response.input,
      output: response.output,
      error: response.error,
      startedAt: response.startedAt ? new Date(response.startedAt) : undefined,
      endedAt: response.endedAt ? new Date(response.endedAt) : undefined,
      createdAt: new Date(response.createdAt),
      updatedAt: new Date(response.updatedAt),
    };
  }
}

/**
 * Singleton instance
 */
export const ironflow = new IronflowClient();

/**
 * Export the class for advanced usage
 */
export { IronflowClient };
