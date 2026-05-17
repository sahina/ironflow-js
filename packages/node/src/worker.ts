/**
 * Ironflow Worker Client
 *
 * Pull mode worker that polls the Ironflow server for jobs.
 */

import type {
  IronflowFunction,
  Logger,
  FunctionContext,
  StepResult,
} from "@ironflow/core";
import {
  IronflowError,
  JobAssignmentSchema,
  createLogger,
  createNoopLogger,
  DEFAULT_SERVER_URL,
  DEFAULT_WORKER,
  HEADERS,
  DEFAULT_ENVIRONMENT,
  getServerUrl,
  type ValidatedJobAssignment,
} from "@ironflow/core";
import type { WorkerConfig, Worker } from "./types.js";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient, executeCompensations } from "./step.js";
import { isYieldSignal, type YieldInfo } from "./internal/errors.js";
import { createProjectionRunner, StreamingUnsupportedError, type ProjectionRunner } from "./projection-runner.js";
import { createSecretsClient } from "./secrets.js";
import { withRunContext } from "./internal/run-context.js";
import { SDK_VERSION } from "./version.js";

/**
 * Worker lifecycle states
 */
type WorkerState = "idle" | "connecting" | "connected" | "draining" | "stopped";

/**
 * Active job tracking
 */
interface ActiveJob {
  jobId: string;
  runId: string;
  functionId: string;
  startedAt: Date;
  abortController: AbortController;
}

/**
 * Create a worker for Pull mode execution
 *
 * @example
 * ```typescript
 * import { createWorker } from "@ironflow/node/worker";
 *
 * const worker = createWorker({
 *   serverUrl: "http://localhost:9123",
 *   functions: [myFunction],
 *   maxConcurrentJobs: 4,
 * });
 *
 * await worker.start();
 * ```
 */
export function createWorker(config: WorkerConfig): Worker {
  return new IronflowWorker(config);
}

/**
 * Worker implementation using REST HTTP polling
 */
class IronflowWorker implements Worker {
  private readonly config: WorkerConfig;
  private readonly functionMap: Map<string, IronflowFunction>;
  private readonly workerId: string;
  private readonly maxConcurrentJobs: number;
  private readonly heartbeatInterval: number;
  private readonly reconnectDelay: number;
  private readonly logger: Logger;
  private readonly environment: string;
  private readonly apiKey?: string;

  private state: WorkerState = "idle";
  private activeJobs: Map<string, ActiveJob> = new Map();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private abortController?: AbortController;
  private projectionRunners: ProjectionRunner[] = [];

  constructor(config: WorkerConfig) {
    this.config = {
      ...config,
      serverUrl: config.serverUrl || getServerUrl() || DEFAULT_SERVER_URL,
    };
    this.workerId = generateWorkerId();
    this.maxConcurrentJobs =
      config.maxConcurrentJobs ?? DEFAULT_WORKER.MAX_CONCURRENT_JOBS;
    this.heartbeatInterval =
      config.heartbeatInterval ?? DEFAULT_WORKER.HEARTBEAT_INTERVAL_MS;
    this.reconnectDelay =
      config.reconnectDelay ?? DEFAULT_WORKER.RECONNECT_DELAY_MS;
    this.environment =
      config.environment ?? process.env.IRONFLOW_ENV ?? DEFAULT_ENVIRONMENT;
    this.apiKey = config.apiKey ?? process.env.IRONFLOW_API_KEY;

    // Initialize logger
    if (config.logger === false) {
      this.logger = createNoopLogger();
    } else if (config.logger) {
      this.logger = config.logger;
    } else {
      this.logger = createLogger({ prefix: "[ironflow-worker]" });
    }

    // Build function map
    this.functionMap = new Map();
    for (const fn of config.functions) {
      if (this.functionMap.has(fn.config.id)) {
        this.logger.warn(
          `Duplicate function ID "${fn.config.id}" — the later definition will overwrite the earlier one. ` +
          "Each function should have a unique ID."
        );
      }
      this.functionMap.set(fn.config.id, fn);
    }
  }

  /**
   * Start the worker (blocks until stopped)
   */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new IronflowError("Worker is already running", {
        code: "WORKER_ALREADY_RUNNING",
      });
    }

    this.state = "connecting";
    this.abortController = new AbortController();

    this.logger.info(
      `Starting worker ${this.workerId} with ${this.functionMap.size} functions`
    );

    // Connect loop with auto-reconnect
    // Use explicit type annotation to allow state changes from other methods
    while ((this.state as WorkerState) !== "stopped") {
      try {
        await this.connect();
      } catch (error) {
        if ((this.state as WorkerState) === "stopped") {
          break;
        }

        this.logger.error("Connection error", { error: String(error) });
        this.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);

        await this.sleep(this.reconnectDelay);
      }
    }

    this.logger.info("Worker stopped");
  }

  /**
   * Gracefully drain and stop
   */
  async drain(): Promise<void> {
    if (this.state === "stopped" || this.state === "idle") {
      return;
    }

    this.logger.info("Draining worker...");
    this.state = "draining";

    // Wait for active jobs to complete
    while (this.activeJobs.size > 0) {
      this.logger.info(
        `Waiting for ${this.activeJobs.size} jobs to complete...`
      );
      await this.sleep(1000);
    }

    this.stop();
  }

  /**
   * Force stop immediately
   */
  stop(): void {
    this.state = "stopped";
    this.abortController?.abort();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Stop projection runners
    for (const runner of this.projectionRunners) {
      runner.stop().catch(() => {});
    }
    this.projectionRunners = [];

    // Cancel all active jobs
    for (const job of this.activeJobs.values()) {
      job.abortController.abort();
    }
    this.activeJobs.clear();
  }

  /**
   * Build common headers including environment
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [HEADERS.ENVIRONMENT]: this.environment,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Establish connection to the Ironflow server
   */
  private async connect(): Promise<void> {
    this.state = "connecting";

    // Clean up from previous connection (e.g. after server restart)
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const runner of this.projectionRunners) {
      runner.stop().catch(() => {});
    }
    this.projectionRunners = [];

    const baseUrl = this.config.serverUrl!.replace(/\/$/, "");

    // Register functions so the event router can find them
    await this.registerFunctions(baseUrl);

    // Register worker
    await this.registerWorker(baseUrl);

    this.state = "connected";
    this.logger.info(`Connected to server at ${this.config.serverUrl}`);

    // Start projection runners (if any)
    this.startProjectionRunners(baseUrl);

    // Start heartbeat
    this.startHeartbeat(baseUrl);

    // Poll for jobs
    await this.pollForJobs(baseUrl);
  }

  /**
   * Register all worker functions with the Ironflow server
   */
  private async registerFunctions(baseUrl: string): Promise<void> {
    for (const [fnId, fn] of this.functionMap) {
      const body: Record<string, unknown> = {
        id: fn.config.id,
        name: fn.config.name || fn.config.id,
        triggers: fn.config.triggers || [],
        preferredMode: "EXECUTION_MODE_PULL",
      };

      if (fn.config.description) body.description = fn.config.description;
      if (fn.config.retry) body.retry = fn.config.retry;
      if (fn.config.timeout) body.timeoutMs = fn.config.timeout;
      if (fn.config.concurrency) body.concurrency = fn.config.concurrency;
      if (fn.config.debounce) {
        // Server expects snake_case period_ms / max_wait_ms;
        // SDK uses camelCase for parity with the rest of the TS surface.
        body.debounce = {
          period_ms: fn.config.debounce.periodMs,
          key: fn.config.debounce.key ?? "",
          ...(fn.config.debounce.maxWaitMs != null
            ? { max_wait_ms: fn.config.debounce.maxWaitMs }
            : {}),
        };
      }
      if (fn.config.actorKey) body.actorKey = fn.config.actorKey;
      if (fn.config.recording != null) body.recording = fn.config.recording;
      if (fn.config.recordingRetention != null) body.recordingRetention = fn.config.recordingRetention;
      if (fn.config.pauseBehavior) body.pauseBehavior = fn.config.pauseBehavior;
      if (fn.config.metadata) body.metadata = fn.config.metadata;
      if (fn.config.secrets?.length) body.secrets = fn.config.secrets;
      if (fn.config.compensateOnCancel) body.compensateOnCancel = true;
      if (fn.config.cancelOn?.length) {
        body.cancelOn = fn.config.cancelOn.map((s) => ({
          event: s.event,
          match: s.match,
        }));
      }

      const response = await fetch(
        `${baseUrl}/ironflow.v1.IronflowService/RegisterFunction`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: this.abortController?.signal,
        }
      );

      if (!response.ok) {
        throw new IronflowError(
          `Failed to register function ${fnId}: ${response.status}`,
          { code: "FUNCTION_REGISTRATION_FAILED" }
        );
      }

      this.logger.info(`Registered function: ${fnId}`);
    }
  }

  /**
   * Register the worker with the Ironflow server
   */
  private async registerWorker(baseUrl: string): Promise<void> {
    const functionIds = Array.from(this.functionMap.keys());

    const response = await fetch(
      `${baseUrl}/api/v1/workers/${this.workerId}/register`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          worker_id: this.workerId,
          hostname: getHostname(),
          function_ids: functionIds,
          max_concurrent_jobs: this.maxConcurrentJobs,
          labels: this.config.labels ?? {},
          version: {
            sdk: SDK_VERSION,
            runtime: `node-${process.version}`,
          },
        }),
        signal: this.abortController?.signal,
      }
    );

    if (!response.ok) {
      throw new IronflowError("Failed to register worker", {
        code: "REGISTRATION_FAILED",
      });
    }
  }

  /**
   * Start projection runners in background
   */
  private startProjectionRunners(baseUrl: string): void {
    if (!this.config.projections?.length) {
      return;
    }

    for (const proj of this.config.projections) {
      const runner = createProjectionRunner({
        projection: proj,
        baseUrl,
        headers: this.buildHeaders(),
        logger: this.logger,
        signal: this.abortController?.signal,
      });
      this.projectionRunners.push(runner);

      // Try streaming first, fall back to polling if unsupported
      runner.startStreaming().catch((err) => {
        if (err instanceof StreamingUnsupportedError) {
          this.logger.info(
            `Streaming not available for ${proj.config.name}, falling back to polling`
          );
          runner.start().catch((pollErr) => {
            this.logger.error(`Projection runner failed: ${pollErr}`);
          });
        } else {
          this.logger.error(`Projection runner failed: ${err}`);
        }
      });
    }

    this.logger.info(
      `Started ${this.config.projections.length} projection runner(s)`
    );
  }

  /**
   * Start the heartbeat interval
   */
  private startHeartbeat(baseUrl: string): void {
    this.heartbeatTimer = setInterval(async () => {
      if (this.state !== "connected") {
        return;
      }

      try {
        await fetch(`${baseUrl}/api/v1/workers/${this.workerId}/heartbeat`, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify({
            worker_id: this.workerId,
            active_jobs: this.activeJobs.size,
            jobs: Array.from(this.activeJobs.values()).map((job) => ({
              job_id: job.jobId,
              started_at: job.startedAt.toISOString(),
            })),
          }),
          signal: this.abortController?.signal,
        });
      } catch (error) {
        this.logger.warn("Heartbeat failed", { error: String(error) });
      }
    }, this.heartbeatInterval);
  }

  /**
   * Continuously poll the server for available jobs
   */
  private async pollForJobs(baseUrl: string): Promise<void> {
    while (this.state === "connected") {
      // Check capacity
      if (this.activeJobs.size >= this.maxConcurrentJobs) {
        await this.sleep(1000);
        continue;
      }

      try {
        // Request a job
        const response = await fetch(
          `${baseUrl}/api/v1/workers/${this.workerId}/jobs`,
          {
            method: "GET",
            headers: this.buildHeaders(),
            signal: this.abortController?.signal,
          }
        );

        if (response.status === 204) {
          // No jobs available
          await this.sleep(1000);
          continue;
        }

        if (response.status === 404) {
          // Worker or function not registered — server likely restarted.
          // Break polling so connect() returns and start() re-registers.
          this.logger.warn(
            "Worker not found on server (404) — will re-register"
          );
          this.state = "connecting";
          return;
        }

        if (!response.ok) {
          throw new Error(`Failed to get job: ${response.status}`);
        }

        // Parse and validate job assignment
        const rawJob: unknown = await response.json();
        const result = JobAssignmentSchema.safeParse(rawJob);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", ");
          this.logger.error(`Invalid job assignment: ${issues}`);
          await this.sleep(1000);
          continue;
        }

        // Process the validated job
        this.processJob(baseUrl, result.data);
      } catch (error) {
        if (this.state !== "connected") {
          break;
        }

        this.logger.warn("Job polling error", { error: String(error) });
        await this.sleep(5000);
      }
    }
  }

  /**
   * Start processing a job asynchronously
   */
  private processJob(baseUrl: string, job: ValidatedJobAssignment): void {
    const abortController = new AbortController();
    const activeJob: ActiveJob = {
      jobId: job.job_id,
      runId: job.run_id,
      functionId: job.function_id,
      startedAt: new Date(),
      abortController,
    };

    this.activeJobs.set(job.job_id, activeJob);

    // Execute in background
    this.executeJob(baseUrl, job, abortController.signal)
      .catch((error) => {
        this.logger.error(`Job ${job.job_id} failed`, { error: String(error) });
      })
      .finally(() => {
        this.activeJobs.delete(job.job_id);
      });
  }

  /**
   * Execute a job and report results
   */
  private async executeJob(
    baseUrl: string,
    job: ValidatedJobAssignment,
    signal: AbortSignal
  ): Promise<void> {
    const fn = this.functionMap.get(job.function_id);
    if (!fn) {
      await this.sendJobFailed(baseUrl, job.job_id, {
        message: `Function not found: ${job.function_id}`,
        code: "FUNCTION_NOT_FOUND",
        retryable: false,
      });
      return;
    }

    this.logger.info(`Processing job ${job.job_id} for ${job.function_id}`);

    // Build execution context from job assignment (with optional upcasting)
    const ctx = new ExecutionContext({
      run_id: job.run_id,
      function_id: job.function_id,
      attempt: job.attempt,
      event: job.event,
      steps: job.completed_steps.map((s) => ({
        id: s.step_id,
        name: s.name,
        status: "completed" as const,
        output: s.output,
      })),
      resume: undefined,
    }, undefined, this.config.eventDefinitions, fn.config.stepTimeout, this.config.serverUrl);

    const step = createStepClient(ctx);
    const functionContext: FunctionContext = {
      event: ctx.event,
      step,
      run: ctx.runInfo,
      logger: ctx.logger,
      secrets: createSecretsClient(job.context?.secrets),
    };

    try {
      // Check for abort
      if (signal.aborted) {
        return;
      }

      const result = await withRunContext(ctx.runId, () =>
        fn.handler(functionContext)
      );

      // Send completion with executed steps
      await this.sendJobCompleted(
        baseUrl,
        job.job_id,
        result,
        ctx.getExecutedSteps()
      );
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      if (isYieldSignal(error)) {
        // Send yield
        await this.sendStepYielded(baseUrl, job.job_id, error.yieldInfo);
        return;
      }

      const retryable = error instanceof IronflowError ? error.retryable : true;

      // Run compensations only if error is not retryable (terminal failure)
      if (ctx.hasCompensations() && !retryable) {
        await executeCompensations(ctx);
      }

      // Send failure with executed steps (includes compensation steps)
      await this.sendJobFailed(baseUrl, job.job_id, {
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof IronflowError ? error.code : "ERROR",
        retryable,
      }, ctx.getExecutedSteps());
    }
  }

  /**
   * Report successful job completion
   */
  private async sendJobCompleted(
    baseUrl: string,
    jobId: string,
    output: unknown,
    steps: StepResult[]
  ): Promise<void> {
    await fetch(`${baseUrl}/api/v1/workers/${this.workerId}/jobs/${jobId}`, {
      method: "PUT",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        status: "completed",
        output,
        steps,
      }),
    });
  }

  /**
   * Report job failure
   */
  private async sendJobFailed(
    baseUrl: string,
    jobId: string,
    error: { message: string; code: string; retryable: boolean },
    steps?: StepResult[]
  ): Promise<void> {
    const body: Record<string, unknown> = {
      status: "failed",
      error,
    };
    if (steps && steps.length > 0) {
      body.steps = steps;
    }
    await fetch(`${baseUrl}/api/v1/workers/${this.workerId}/jobs/${jobId}`, {
      method: "PUT",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
  }

  /**
   * Report step yield
   */
  private async sendStepYielded(
    baseUrl: string,
    jobId: string,
    yieldInfo: YieldInfo
  ): Promise<void> {
    await fetch(`${baseUrl}/api/v1/workers/${this.workerId}/jobs/${jobId}`, {
      method: "PUT",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        status: "yielded",
        yield: yieldInfo,
      }),
    });
  }

  /**
   * Async sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Generate a unique worker ID
 */
function generateWorkerId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `worker-${timestamp}-${random}`;
}

/**
 * Get the hostname from environment
 */
function getHostname(): string {
  if (typeof process !== "undefined" && process.env["HOSTNAME"]) {
    return process.env["HOSTNAME"];
  }
  return "unknown";
}

// NOTE: createStreamingWorker is NOT re-exported here to avoid loading protobuf
// dependencies. Import from "@ironflow/node/worker-streaming" if you need it.

/**
 * Default export
 */
export default createWorker;
