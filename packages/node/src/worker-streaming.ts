/**
 * Ironflow Streaming Worker
 *
 * ConnectRPC bidirectional streaming worker for low-latency pull mode.
 */

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { create, type JsonObject } from "@bufbuild/protobuf";
import type {
  IronflowFunction,
  Logger,
  FunctionContext,
  StepResult,
} from "@ironflow/core";
import {
  AUTH_HELP,
  IronflowError,
  isRetryable,
  createLogger,
  createNoopLogger,
  DEFAULT_SERVER_URL,
  DEFAULT_WORKER,
  HEADERS,
  UnauthenticatedError,
  UnauthorizedError,
} from "@ironflow/core";
import {
  WorkerService,
  WorkerMessageSchema,
  WorkerRegisterSchema,
  WorkerHeartbeatSchema,
  JobCompletedSchema,
  JobFailedSchema,
  JobAckSchema,
  JobNackSchema,
  ErrorSchema,
  ExecutedStepSchema,
  StepStartedSchema,
  StepCompletedSchema,
  StepFailedSchema,
  StepType,
  JobNackReason,
  type WorkerMessage,
  type EngineMessage,
  type JobAssignment,
  type StepYielded,
} from "@ironflow/core/gen";
import type { WorkerConfig, Worker } from "./types.js";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient, executeCompensations } from "./step.js";
import { isYieldSignal } from "./internal/errors.js";
import { stepYieldedMessage, memoSteps, jobOutputFields } from "./internal/stream-yield.js";
import { createSecretsClient } from "./secrets.js";
import { validateEventData } from "./internal/validate-event.js";
import { withRunContext } from "./internal/run-context.js";
import {
  buildWorkerHeaders,
  registerFunctions,
  resolveEnvironment,
} from "./internal/register-functions.js";
import { startProjectionRunners, type ProjectionRunner } from "./projection-runner.js";
import { drainOnSignal } from "./internal/drain-on-signal.js";
import { SDK_VERSION } from "./version.js";

/**
 * Worker states
 */
type WorkerState = "idle" | "connecting" | "connected" | "draining" | "stopped";

// Abort reason for jobs that lose their stream. An engine cancel aborts with the
// default reason: that job still reports its result (#1206, D1). A job that lost
// its stream must not, since its fence belongs to a session that is gone (#2479).
const STREAM_CLOSED = new Error("stream closed");

/**
 * Active job tracking
 */
interface ActiveJob {
  jobId: string;
  runId: string;
  functionId: string;
  startedAt: Date;
  abortController: AbortController;
  // Execution fence (#1206, ADR 0037, chunk 3e), captured from the JobAssignment.
  // Echoed on every mutating message so the engine's ingress guard can validate
  // it. Zero (0n / "") for legacy / non-capacity assignments.
  executionSeq: bigint;
  leaseToken: string;
}

// Type for ConnectRPC client with connect method
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkerClient = ReturnType<typeof createClient<any>> & {
  connect: (
    messages: AsyncIterable<WorkerMessage>,
    options?: { signal?: AbortSignal }
  ) => AsyncIterable<EngineMessage>;
};

/**
 * Create a streaming worker for Pull mode execution using ConnectRPC
 *
 * Uses bidirectional gRPC streaming for efficient job dispatch.
 *
 * @param config - Worker configuration
 * @returns Worker instance
 */
export function createStreamingWorker(config: WorkerConfig): Worker {
  return new StreamingWorker(config);
}

/**
 * Streaming Worker implementation using ConnectRPC bidirectional streaming
 */
class StreamingWorker implements Worker {
  private readonly config: WorkerConfig;
  private readonly functionMap: Map<string, IronflowFunction>;
  private readonly workerId: string;
  private readonly maxConcurrentJobs: number;
  private readonly heartbeatInterval: number;
  private readonly reconnectDelay: number;
  private readonly drainTimeout: number;
  private readonly logger: Logger;
  private readonly apiKey?: string;
  private readonly environment: string;

  private state: WorkerState = "idle";
  private activeJobs: Map<string, ActiveJob> = new Map();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private projectionRunners: ProjectionRunner[] = [];
  private abortController?: AbortController;
  private sendMessage?: (msg: WorkerMessage) => void;
  private drainPromise?: Promise<void>;
  private removeSignalDrain?: () => void;
  // Half-closes the current stream after the queued messages. Set by connect().
  private endOutgoing?: () => void;

  constructor(config: WorkerConfig) {
    this.config = {
      ...config,
      serverUrl: config.serverUrl || DEFAULT_SERVER_URL,
    };
    this.workerId = generateWorkerId();
    this.maxConcurrentJobs =
      config.maxConcurrentJobs ?? DEFAULT_WORKER.MAX_CONCURRENT_JOBS;
    this.heartbeatInterval =
      config.heartbeatInterval ?? DEFAULT_WORKER.HEARTBEAT_INTERVAL_MS;
    this.reconnectDelay =
      config.reconnectDelay ?? DEFAULT_WORKER.RECONNECT_DELAY_MS;
    this.drainTimeout =
      config.drainTimeout && config.drainTimeout > 0 ? config.drainTimeout : DEFAULT_WORKER.DRAIN_TIMEOUT_MS;
    this.apiKey = config.apiKey || process.env.IRONFLOW_API_KEY;
    this.environment = resolveEnvironment(config.environment);

    // Initialize logger
    if (config.logger === false) {
      this.logger = createNoopLogger();
    } else if (config.logger) {
      this.logger = config.logger;
    } else {
      this.logger = createLogger({ prefix: "[ironflow-streaming]" });
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
    this.removeSignalDrain = drainOnSignal(() => this.drain());

    this.logger.info(
      `Starting streaming worker ${this.workerId} with ${this.functionMap.size} functions`
    );

    // Connect loop with auto-reconnect
    while ((this.state as WorkerState) !== "stopped") {
      // Without a stream no result can reach the engine, so a draining worker
      // stops here and does not reconnect.
      if ((this.state as WorkerState) === "draining") {
        this.stop();
        break;
      }
      try {
        await this.connect();
      } catch (error) {
        if (
          (this.state as WorkerState) === "stopped" ||
          (this.state as WorkerState) === "draining"
        ) {
          continue;
        }

        // Auth failures do not fix themselves on the reconnect cadence (#1673).
        // Two shapes reach here: a ConnectError from the stream, and a plain
        // Unauthenticated/UnauthorizedError from the function registration
        // fetch that now runs first (#2027) — that one is not a ConnectError.
        if (
          (error instanceof ConnectError &&
            (error.code === Code.Unauthenticated ||
              error.code === Code.PermissionDenied)) ||
          error instanceof UnauthenticatedError ||
          error instanceof UnauthorizedError
        ) {
          this.logger.error(`Stream authentication failed: ${String(error)}. ${AUTH_HELP}`);
          this.stop();
          throw error;
        }

        this.logger.error("Connection error", { error: String(error) });
        this.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);

        await this.sleep(this.reconnectDelay);
      }
    }

    this.logger.info("Streaming worker stopped");
  }

  /**
   * Gracefully drain and stop
   */
  drain(): Promise<void> {
    return this.drainWithin(this.drainTimeout);
  }

  private drainWithin(timeoutMs: number): Promise<void> {
    if (this.state === "stopped" || this.state === "idle") {
      return Promise.resolve();
    }
    if (this.drainPromise) return this.drainPromise;

    this.logger.info("Draining worker...");
    this.state = "draining";

    this.drainPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      const draining = () =>
        (this.state as WorkerState) === "draining" && Date.now() < deadline;
      while (this.activeJobs.size > 0 && draining()) {
        this.logger.info(`Waiting for ${this.activeJobs.size} jobs to complete...`);
        await this.sleep(Math.min(1000, deadline - Date.now()));
      }
      if (this.activeJobs.size > 0) {
        this.logger.warn(`Drain deadline reached; cancelling ${this.activeJobs.size} active jobs`);
      } else {
        // Close the stream gracefully. stop() aborts it, and the engine can
        // then miss the last results. The stream sends what is queued and
        // half-closes, the engine reads to the end and closes it, and start()
        // stops the worker.
        this.endOutgoing?.();
        while (draining()) {
          await this.sleep(Math.min(100, deadline - Date.now()));
        }
      }
      this.stop();
    })();
    return this.drainPromise;
  }

  /**
   * Force stop immediately
   */
  stop(): void {
    this.state = "stopped";
    this.removeSignalDrain?.();
    this.removeSignalDrain = undefined;
    this.abortController?.abort();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.stopProjectionRunners();

    // Cancel all active jobs
    for (const job of this.activeJobs.values()) {
      job.abortController.abort();
    }
    this.activeJobs.clear();
  }

  private stopProjectionRunners(): void {
    for (const runner of this.projectionRunners) {
      runner.stop().catch(() => {});
    }
    this.projectionRunners = [];
  }

  /**
   * Build common headers including environment
   */
  private buildHeaders(): Record<string, string> {
    return buildWorkerHeaders(this.environment, this.apiKey);
  }

  /**
   * Connect to the server via ConnectRPC bidirectional streaming
   */
  private async connect(): Promise<void> {
    this.state = "connecting";

    // Clean up from a previous connection (e.g. after a server restart).
    this.stopProjectionRunners();

    // Register the function definitions so the event router can match triggers
    // to them. The register frame below carries function *names* only, so
    // without this the worker heartbeats forever and executes nothing (#2027).
    // Inside connect(), not start(), so a reconnect re-registers — a worker that
    // outlives a server restart comes back with its functions intact.
    await registerFunctions({
      baseUrl: this.config.serverUrl!,
      functions: this.functionMap,
      headers: this.buildHeaders(),
      logger: this.logger,
      signal: this.abortController?.signal,
    });

    // drain() or stop() ran during the registration. Do not open a stream:
    // "connected" below would put the worker back into service.
    if ((this.state as WorkerState) !== "connecting") return;

    // Create Connect transport with HTTP/2 for bidirectional streaming
    const apiKey = this.apiKey;
    const environment = this.environment;
    const transport = createConnectTransport({
      baseUrl: this.config.serverUrl!,
      httpVersion: "2",
      interceptors: [
        (next) => async (req) => {
          if (apiKey) req.header.set("Authorization", `Bearer ${apiKey}`);
          // Scope the stream to the same environment the definitions were
          // registered into — otherwise the worker waits in env_default for
          // jobs created elsewhere (#2027).
          req.header.set(HEADERS.ENVIRONMENT, environment);
          return next(req);
        },
      ],
    });

    // Create client with type assertion due to connect-es v1/v2 type mismatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createClient(WorkerService as any, transport) as WorkerClient;

    // Create message queue for sending
    const messageQueue: WorkerMessage[] = [];
    let resolveNext: (() => void) | null = null;
    let ending = false;
    this.endOutgoing = () => {
      ending = true;
      resolveNext?.();
      resolveNext = null;
    };

    // Function to send messages
    this.sendMessage = (msg: WorkerMessage) => {
      messageQueue.push(msg);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    // Async generator for outgoing messages
    async function* outgoingMessages(): AsyncGenerator<WorkerMessage> {
      while (true) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        } else if (ending) {
          // The end of this generator half-closes the stream.
          return;
        } else {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      }
    }

    // Send registration message first
    const registerMsg = create(WorkerMessageSchema, {
      payload: {
        case: "register",
        value: create(WorkerRegisterSchema, {
          workerId: this.workerId,
          hostname: getHostname(),
          functionIds: Array.from(this.functionMap.keys()),
          maxConcurrentJobs: this.maxConcurrentJobs,
          labels: this.config.labels ?? {},
          version: {
            sdk: SDK_VERSION,
            runtime: `node-${process.version}`,
          },
        }),
      },
    });
    this.sendMessage(registerMsg);

    this.state = "connected";
    this.logger.info("Connected to server via streaming");

    // Projections are plain HTTP and independent of the job transport.
    this.projectionRunners = startProjectionRunners({
      projections: this.config.projections,
      baseUrl: this.config.serverUrl!.replace(/\/$/, ""),
      headers: this.buildHeaders(),
      logger: this.logger,
      signal: this.abortController?.signal,
    });

    // Start heartbeat
    this.startHeartbeat();

    // Process incoming messages from the stream
    try {
      // stop() must close the stream: the engine reclaims this worker's leases
      // only after the stream is gone.
      const stream = client.connect(outgoingMessages(), {
        signal: this.abortController?.signal,
      });

      for await (const message of stream) {
        if ((this.state as WorkerState) === "stopped") {
          break;
        }
        await this.handleEngineMessage(message);
      }
    } finally {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      // The engine reclaims this stream's leases and sends the jobs again. An
      // execution that outlives its stream would hold credits the engine gave
      // to the next session and report with a stale fence (#2479). Parity with
      // the Go worker's cancelAllJobs.
      for (const job of this.activeJobs.values()) {
        job.abortController.abort(STREAM_CLOSED);
      }
      this.activeJobs.clear();
      this.sendMessage = undefined;
      this.endOutgoing = undefined;
    }
  }

  /**
   * Handle incoming messages from the engine
   */
  private async handleEngineMessage(message: EngineMessage): Promise<void> {
    switch (message.payload.case) {
      case "registered":
        this.logger.info("Registration confirmed", {
          heartbeatInterval: message.payload.value.heartbeatIntervalMs,
        });
        break;

      case "job":
        await this.handleJobAssignment(message.payload.value);
        break;

      case "resume":
        this.logger.info("Resume job received", {
          jobId: message.payload.value.jobId,
          stepId: message.payload.value.stepId,
        });
        // TODO: Handle job resume
        break;

      case "cancel":
        this.handleJobCancel(
          message.payload.value.jobId,
          message.payload.value.reason
        );
        break;

      case "shutdown":
        this.logger.info("Shutdown requested", {
          reason: message.payload.value.reason,
        });
        // The engine stops waiting after its drain timeout, so use it when it is set.
        this.drainWithin(
          message.payload.value.drainTimeoutMs > 0
            ? message.payload.value.drainTimeoutMs
            : this.drainTimeout
        );
        break;

      default:
        this.logger.warn("Unknown message type", { case: message.payload.case });
    }
  }

  /**
   * Handle a job assignment from the server
   */
  private async handleJobAssignment(job: JobAssignment): Promise<void> {
    // A job the worker cannot run gets a nack (#2456). A nack uses no run
    // attempt, and the engine re-queues the job at once. An engine older than
    // the nack drops the message; it then recovers the job after the lease
    // expires.
    if (this.state === "draining") {
      this.logger.info("Draining, refusing job", { jobId: job.jobId });
      this.nackJob(job, JobNackReason.DRAINING);
      return;
    }
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      this.logger.warn("At capacity, refusing job", { jobId: job.jobId });
      this.nackJob(job, JobNackReason.AT_CAPACITY);
      return;
    }

    // Send ack
    if (this.sendMessage) {
      const ackMsg = create(WorkerMessageSchema, {
        payload: {
          case: "jobAck",
          value: create(JobAckSchema, {
            jobId: job.jobId,
            executionSeq: job.executionSeq,
            leaseToken: job.leaseToken,
          }),
        },
      });
      this.sendMessage(ackMsg);
    }

    // Track active job, stashing the execution fence so the terminal messages
    // can echo it (#1206, ADR 0037, chunk 3e).
    const abortController = new AbortController();
    const activeJob: ActiveJob = {
      jobId: job.jobId,
      runId: job.runId,
      functionId: job.functionId,
      startedAt: new Date(),
      abortController,
      executionSeq: job.executionSeq,
      leaseToken: job.leaseToken,
    };
    this.activeJobs.set(job.jobId, activeJob);

    // Execute in background
    this.executeJob(job, abortController.signal)
      .catch((error) => {
        this.logger.error(`Job ${job.jobId} failed`, { error: String(error) });
      })
      .finally(() => {
        // The engine can deliver this job again after a reconnect. Its entry
        // is not ours to remove (#2479).
        if (this.activeJobs.get(job.jobId) === activeJob) {
          this.activeJobs.delete(job.jobId);
        }
      });
  }

  /**
   * Refuse an assignment the worker did not start, echoing its fence.
   */
  private nackJob(job: JobAssignment, reason: JobNackReason): void {
    this.sendMessage?.(
      create(WorkerMessageSchema, {
        payload: {
          case: "jobNack",
          value: create(JobNackSchema, {
            jobId: job.jobId,
            runId: job.runId,
            executionSeq: job.executionSeq,
            leaseToken: job.leaseToken,
            reason,
          }),
        },
      })
    );
  }

  /**
   * Handle job cancellation
   */
  private handleJobCancel(jobId: string, reason: string): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      this.logger.info("Cancelling job", { jobId, reason });
      // The entry stays until the handler exits, so the capacity count and
      // drain() still see the execution (#2479).
      job.abortController.abort();
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(
    job: JobAssignment,
    signal: AbortSignal
  ): Promise<void> {
    // Capture the execution fence from the assignment up front (#1206, ADR 0037).
    // Terminal messages echo it from here, NOT from a late activeJobs lookup — a
    // stream drop clears the map, and a handler that finishes afterward would
    // otherwise send an empty token and the engine would fenceDisconnect the
    // whole stream. Parity with the Go SDK, whose per-job
    // reporter captures the fence at construction.
    const fence = {
      executionSeq: job.executionSeq,
      leaseToken: job.leaseToken,
    };
    const fn = this.functionMap.get(job.functionId);
    if (!fn) {
      await this.sendJobFailed(
        job.jobId,
        {
          message: `Function not found: ${job.functionId}`,
          code: "FUNCTION_NOT_FOUND",
          retryable: false,
        },
        fence
      );
      return;
    }

    this.logger.info(`Processing job ${job.jobId} for ${job.functionId}`);

    // Convert protobuf event to our format
    const timestampToISO = (
      ts: { seconds: bigint; nanos: number } | undefined
    ): string => {
      if (!ts) return new Date().toISOString();
      const ms = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
      return new Date(ms).toISOString();
    };

    const event = job.event
      ? {
          id: job.event.id,
          name: job.event.name,
          data: job.event.data ?? {},
          version: job.event.version || 1,
          timestamp: timestampToISO(job.event.timestamp),
          source: job.event.source || undefined,
        }
      : {
          id: "",
          name: "",
          data: {},
          timestamp: new Date().toISOString(),
        };

    // Build execution context
    const ctx = new ExecutionContext({
      run_id: job.runId,
      function_id: job.functionId,
      attempt: job.attempt,
      event,
      steps: memoSteps(job.completedSteps),
      resume: undefined,
    }, undefined, this.config.eventDefinitions, fn.config.stepTimeout, this.config.serverUrl, this.apiKey, this.environment);

    // Only step.run() rows are written here: sleep and wait-for-event reach the
    // engine as yields and compensations ride on JobFailed. The engine needs a
    // StepStarted row before it accepts the result, so both go out together.
    ctx.signal = signal;
    ctx.onStepResult = (s) => {
      if (s.type !== "invoke" || signal.reason === STREAM_CLOSED) return;
      this.sendStepResult(job.jobId, s, fence);
    };

    const step = createStepClient(ctx);
    const startTime = Date.now();

    try {
      if (signal.aborted) {
        return;
      }

      const functionContext: FunctionContext = {
        event: await validateEventData(fn, ctx.event),
        step,
        run: ctx.runInfo,
        logger: ctx.logger,
        secrets: createSecretsClient(job.context?.secrets),
      };

      const result = await withRunContext(ctx.runId, () =>
        fn.handler(functionContext)
      );
      const durationMs = Date.now() - startTime;

      if (signal.reason === STREAM_CLOSED) return;

      // Send completion via stream
      await this.sendJobCompleted(job.jobId, result, durationMs, fence);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const durationMs = Date.now() - startTime;

      if (isYieldSignal(error)) {
        this.sendStepYielded(stepYieldedMessage(job.jobId, error.yieldInfo, fence));
        this.logger.debug("Job yielded", { jobId: job.jobId, type: error.yieldInfo.type });
        return;
      }

      const retryable = isRetryable(error);

      // Run compensations only if error is not retryable (terminal failure)
      if (ctx.hasCompensations() && !retryable) {
        await executeCompensations(ctx);
      }

      // Send failure via stream (include compensation steps for terminal failures)
      await this.sendJobFailed(
        job.jobId,
        {
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof IronflowError ? error.code : "ERROR",
          retryable,
          durationMs,
        },
        fence,
        retryable ? [] : ctx.getExecutedSteps()
      );
    }
  }

  /**
   * Send job completed message via stream. The fence (execution_seq, lease_token)
   * is captured from the JobAssignment by the caller (#1206, ADR 0037), not
   * re-derived from the mutable activeJobs map, so a concurrent stream drop
   * cannot blank it.
   */
  private async sendJobCompleted(
    jobId: string,
    output: unknown,
    durationMs: number,
    fence: { executionSeq: bigint; leaseToken: string }
  ): Promise<void> {
    if (!this.sendMessage) return;

    const msg = create(WorkerMessageSchema, {
      payload: {
        case: "jobCompleted",
        value: create(JobCompletedSchema, {
          jobId,
          ...jobOutputFields(output),
          durationMs,
          executionSeq: fence.executionSeq,
          leaseToken: fence.leaseToken,
        }),
      },
    });
    this.sendMessage(msg);
  }

  private sendStepResult(
    jobId: string,
    s: StepResult,
    fence: { executionSeq: bigint; leaseToken: string }
  ): void {
    if (!this.sendMessage) return;
    const base = { jobId, stepId: s.id, ...fence };
    this.sendMessage(
      create(WorkerMessageSchema, {
        payload: {
          case: "stepStarted",
          value: create(StepStartedSchema, { ...base, name: s.name, stepType: StepType.INVOKE }),
        },
      })
    );
    const durationMs = s.duration_ms ?? 0;
    const payload =
      s.status === "completed"
        ? ({
            case: "stepCompleted",
            value: create(StepCompletedSchema, { ...base, ...jobOutputFields(s.output), durationMs }),
          } as const)
        : ({
            case: "stepFailed",
            value: create(StepFailedSchema, {
              ...base,
              error: create(ErrorSchema, {
                message: s.error?.message ?? "",
                retryable: s.error?.retryable ?? false,
              }),
              durationMs,
            }),
          } as const);
    this.sendMessage(create(WorkerMessageSchema, { payload }));
  }

  private sendStepYielded(value: StepYielded): void {
    if (!this.sendMessage) return;
    this.sendMessage(create(WorkerMessageSchema, { payload: { case: "stepYielded", value } }));
  }

  /**
   * Send job failed message via stream
   */
  private async sendJobFailed(
    jobId: string,
    error: {
      message: string;
      code: string;
      retryable: boolean;
      durationMs?: number;
    },
    fence: { executionSeq: bigint; leaseToken: string },
    steps: StepResult[] = []
  ): Promise<void> {
    if (!this.sendMessage) return;

    const msg = create(WorkerMessageSchema, {
      payload: {
        case: "jobFailed",
        value: create(JobFailedSchema, {
          jobId,
          error: create(ErrorSchema, {
            message: error.message,
            code: error.code,
            retryable: error.retryable,
          }),
          durationMs: error.durationMs ?? 0,
          executionSeq: fence.executionSeq,
          leaseToken: fence.leaseToken,
          steps: steps.map((s) =>
            create(ExecutedStepSchema, {
              id: s.id,
              name: s.name,
              type: s.type,
              status: s.status,
              compensationFor: s.compensation_for ?? "",
              durationMs: s.duration_ms ?? 0,
              ...(s.output !== undefined ? { output: s.output as JsonObject } : {}),
              ...(s.error !== undefined
                ? {
                    error: create(ErrorSchema, {
                      message: s.error.message,
                      retryable: s.error.retryable,
                    }),
                  }
                : {}),
            })
          ),
        }),
      },
    });
    this.sendMessage(msg);
  }

  /**
   * Start sending heartbeats via stream
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected" || !this.sendMessage) {
        return;
      }

      const msg = create(WorkerMessageSchema, {
        payload: {
          case: "heartbeat",
          value: create(WorkerHeartbeatSchema, {
            workerId: this.workerId,
            activeJobs: this.activeJobs.size,
            jobs: Array.from(this.activeJobs.values()).map((job) => ({
              jobId: job.jobId,
              startedAt: {
                seconds: BigInt(Math.floor(job.startedAt.getTime() / 1000)),
                nanos: 0,
              },
            })),
          }),
        },
      });
      this.sendMessage(msg);
    }, this.heartbeatInterval);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Generate a unique worker ID
 */
function generateWorkerId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `worker-stream-${timestamp}-${random}`;
}

/**
 * Get the hostname
 */
function getHostname(): string {
  if (typeof process !== "undefined" && process.env["HOSTNAME"]) {
    return process.env["HOSTNAME"];
  }
  return "unknown";
}

export default createStreamingWorker;
