/**
 * Ironflow Streaming Worker
 *
 * ConnectRPC bidirectional streaming worker for low-latency pull mode.
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { create, type JsonObject } from "@bufbuild/protobuf";
import type {
  IronflowFunction,
  Logger,
  FunctionContext,
  StepResult,
} from "@ironflow/core";
import {
  IronflowError,
  createLogger,
  createNoopLogger,
  DEFAULT_SERVER_URL,
  DEFAULT_WORKER,
} from "@ironflow/core";
import {
  WorkerService,
  WorkerMessageSchema,
  WorkerRegisterSchema,
  WorkerHeartbeatSchema,
  JobCompletedSchema,
  JobFailedSchema,
  JobAckSchema,
  ErrorSchema,
  ExecutedStepSchema,
  type WorkerMessage,
  type EngineMessage,
  type JobAssignment,
} from "@ironflow/core/gen";
import type { WorkerConfig, Worker } from "./types.js";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient, executeCompensations } from "./step.js";
import { isYieldSignal } from "./internal/errors.js";
import { isRetryable } from "@ironflow/core";
import { createSecretsClient } from "./secrets.js";
import { withRunContext } from "./internal/run-context.js";
import { SDK_VERSION } from "./version.js";

/**
 * Worker states
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

// Type for ConnectRPC client with connect method
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkerClient = ReturnType<typeof createClient<any>> & {
  connect: (
    messages: AsyncIterable<WorkerMessage>
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
  private readonly logger: Logger;
  private readonly apiKey?: string;

  private state: WorkerState = "idle";
  private activeJobs: Map<string, ActiveJob> = new Map();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private abortController?: AbortController;
  private sendMessage?: (msg: WorkerMessage) => void;

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
    this.apiKey = config.apiKey ?? process.env.IRONFLOW_API_KEY;

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

    this.logger.info(
      `Starting streaming worker ${this.workerId} with ${this.functionMap.size} functions`
    );

    // Connect loop with auto-reconnect
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

    this.logger.info("Streaming worker stopped");
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

    // Cancel all active jobs
    for (const job of this.activeJobs.values()) {
      job.abortController.abort();
    }
    this.activeJobs.clear();
  }

  /**
   * Connect to the server via ConnectRPC bidirectional streaming
   */
  private async connect(): Promise<void> {
    this.state = "connecting";

    // Create Connect transport with HTTP/2 for bidirectional streaming
    const apiKey = this.apiKey;
    const transport = createConnectTransport({
      baseUrl: this.config.serverUrl!,
      httpVersion: "2",
      interceptors: apiKey
        ? [
            (next) => async (req) => {
              req.header.set("Authorization", `Bearer ${apiKey}`);
              return next(req);
            },
          ]
        : [],
    });

    // Create client with type assertion due to connect-es v1/v2 type mismatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createClient(WorkerService as any, transport) as WorkerClient;

    // Create message queue for sending
    const messageQueue: WorkerMessage[] = [];
    let resolveNext: (() => void) | null = null;

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

    // Start heartbeat
    this.startHeartbeat();

    // Process incoming messages from the stream
    try {
      const stream = client.connect(outgoingMessages());

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
        this.drain();
        break;

      default:
        this.logger.warn("Unknown message type", { case: message.payload.case });
    }
  }

  /**
   * Handle a job assignment from the server
   */
  private async handleJobAssignment(job: JobAssignment): Promise<void> {
    // Check capacity
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      this.logger.warn("At capacity, cannot accept job", { jobId: job.jobId });
      return;
    }

    // Send ack
    if (this.sendMessage) {
      const ackMsg = create(WorkerMessageSchema, {
        payload: {
          case: "jobAck",
          value: create(JobAckSchema, {
            jobId: job.jobId,
          }),
        },
      });
      this.sendMessage(ackMsg);
    }

    // Track active job
    const abortController = new AbortController();
    const activeJob: ActiveJob = {
      jobId: job.jobId,
      runId: job.runId,
      functionId: job.functionId,
      startedAt: new Date(),
      abortController,
    };
    this.activeJobs.set(job.jobId, activeJob);

    // Execute in background
    this.executeJob(job, abortController.signal)
      .catch((error) => {
        this.logger.error(`Job ${job.jobId} failed`, { error: String(error) });
      })
      .finally(() => {
        this.activeJobs.delete(job.jobId);
      });
  }

  /**
   * Handle job cancellation
   */
  private handleJobCancel(jobId: string, reason: string): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      this.logger.info("Cancelling job", { jobId, reason });
      job.abortController.abort();
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(
    job: JobAssignment,
    signal: AbortSignal
  ): Promise<void> {
    const fn = this.functionMap.get(job.functionId);
    if (!fn) {
      await this.sendJobFailed(job.jobId, {
        message: `Function not found: ${job.functionId}`,
        code: "FUNCTION_NOT_FOUND",
        retryable: false,
      });
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
          timestamp: timestampToISO(job.event.timestamp),
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
      steps: job.completedSteps.map((s) => ({
        id: s.stepId,
        name: s.name,
        status: "completed" as const,
        output: s.output,
      })),
      resume: undefined,
    }, undefined, undefined, fn.config.stepTimeout, this.config.serverUrl);

    const step = createStepClient(ctx);
    const functionContext: FunctionContext = {
      event: ctx.event,
      step,
      run: ctx.runInfo,
      logger: ctx.logger,
      secrets: createSecretsClient(job.context?.secrets),
    };

    const startTime = Date.now();

    try {
      if (signal.aborted) {
        return;
      }

      const result = await withRunContext(ctx.runId, () =>
        fn.handler(functionContext)
      );
      const durationMs = Date.now() - startTime;

      // Send completion via stream
      await this.sendJobCompleted(job.jobId, result, durationMs);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const durationMs = Date.now() - startTime;

      if (isYieldSignal(error)) {
        // TODO: Send step yielded via stream
        this.logger.info("Job yielded", { jobId: job.jobId });
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
        retryable ? [] : ctx.getExecutedSteps()
      );
    }
  }

  /**
   * Send job completed message via stream
   */
  private async sendJobCompleted(
    jobId: string,
    output: unknown,
    durationMs: number
  ): Promise<void> {
    if (!this.sendMessage) return;

    const msg = create(WorkerMessageSchema, {
      payload: {
        case: "jobCompleted",
        value: create(JobCompletedSchema, {
          jobId,
          output: output as JsonObject,
          durationMs,
        }),
      },
    });
    this.sendMessage(msg);
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
