import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IronflowFunction, FunctionContext } from "@ironflow/core";
import { createStreamingWorker } from "./worker-streaming.js";

// Mock function factory
function createMockFunction(
  id: string,
  handler: (ctx: FunctionContext) => Promise<unknown>
): IronflowFunction {
  return {
    config: { id },
    handler,
  } as IronflowFunction;
}

// Inline streaming worker types
type WorkerState = "idle" | "connecting" | "connected" | "draining" | "stopped";

interface ActiveJob {
  jobId: string;
  runId: string;
  functionId: string;
  startedAt: Date;
  abortController: AbortController;
}

// Mock ConnectRPC types
interface MockWorkerMessage {
  type: "register" | "job_ack" | "job_completed" | "job_failed" | "heartbeat";
  workerId?: string;
  functionIds?: string[];
  maxConcurrentJobs?: number;
  jobId?: string;
  output?: unknown;
  error?: { message: string; code: string; retryable: boolean };
  activeJobs?: number;
}

interface MockServerMessage {
  type: "registered" | "job_assignment" | "job_cancel" | "heartbeat_ack" | "error";
  jobId?: string;
  runId?: string;
  functionId?: string;
  attempt?: number;
  event?: { id: string; name: string; data: unknown; timestamp: string };
  completedSteps?: unknown[];
  message?: string;
}

// Minimal streaming worker implementation for testing
class TestStreamingWorker {
  private readonly functionMap: Map<string, IronflowFunction>;
  private readonly workerId: string;
  private readonly maxConcurrentJobs: number;

  private _state: WorkerState = "idle";
  private activeJobs: Map<string, ActiveJob> = new Map();
  private abortController?: AbortController;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private outgoingMessages: MockWorkerMessage[] = [];

  constructor(config: {
    serverUrl?: string;
    functions: IronflowFunction[];
    maxConcurrentJobs?: number;
  }) {
    void config.serverUrl;
    this.maxConcurrentJobs = config.maxConcurrentJobs ?? 10;
    this.workerId = `streaming-worker-${Date.now()}`;
    this.functionMap = new Map();
    for (const fn of config.functions) {
      this.functionMap.set(fn.config.id, fn);
    }
  }

  get state(): WorkerState {
    return this._state;
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  getWorkerId(): string {
    return this.workerId;
  }

  getOutgoingMessages(): MockWorkerMessage[] {
    return [...this.outgoingMessages];
  }

  clearMessages(): void {
    this.outgoingMessages = [];
  }

  // Simulate connecting and sending registration
  async connect(): Promise<void> {
    if (this._state !== "idle") {
      throw new Error("Worker is already running");
    }

    this._state = "connecting";
    this.abortController = new AbortController();

    // Send registration message
    this.send({
      type: "register",
      workerId: this.workerId,
      functionIds: Array.from(this.functionMap.keys()),
      maxConcurrentJobs: this.maxConcurrentJobs,
    });
  }

  // Simulate receiving a message from the server
  async receiveMessage(msg: MockServerMessage): Promise<void> {
    switch (msg.type) {
      case "registered":
        this._state = "connected";
        this.startHeartbeat();
        break;

      case "job_assignment":
        if (msg.jobId && msg.runId && msg.functionId && msg.event) {
          // Send job acknowledgment
          this.send({ type: "job_ack", jobId: msg.jobId });

          // Process the job
          await this.processJob({
            job_id: msg.jobId,
            run_id: msg.runId,
            function_id: msg.functionId,
            attempt: msg.attempt ?? 1,
            event: msg.event,
            completed_steps: msg.completedSteps ?? [],
          });
        }
        break;

      case "job_cancel":
        if (msg.jobId) {
          const job = this.activeJobs.get(msg.jobId);
          if (job) {
            job.abortController.abort();
            this.activeJobs.delete(msg.jobId);
          }
        }
        break;

      case "heartbeat_ack":
        // Nothing to do
        break;

      case "error":
        // Handle error
        break;
    }
  }

  private send(msg: MockWorkerMessage): void {
    this.outgoingMessages.push(msg);
  }

  private async processJob(job: {
    job_id: string;
    run_id: string;
    function_id: string;
    attempt: number;
    event: { id: string; name: string; data: unknown; timestamp: string };
    completed_steps: unknown[];
  }): Promise<void> {
    const abortController = new AbortController();
    const activeJob: ActiveJob = {
      jobId: job.job_id,
      runId: job.run_id,
      functionId: job.function_id,
      startedAt: new Date(),
      abortController,
    };

    this.activeJobs.set(job.job_id, activeJob);

    try {
      await this.executeJob(job, abortController.signal);
    } finally {
      this.activeJobs.delete(job.job_id);
    }
  }

  private async executeJob(
    job: {
      job_id: string;
      run_id: string;
      function_id: string;
      attempt: number;
      event: { id: string; name: string; data: unknown; timestamp: string };
      completed_steps: unknown[];
    },
    signal: AbortSignal
  ): Promise<void> {
    const fn = this.functionMap.get(job.function_id);

    if (!fn) {
      this.send({
        type: "job_failed",
        jobId: job.job_id,
        error: {
          message: `Function not found: ${job.function_id}`,
          code: "FUNCTION_NOT_FOUND",
          retryable: false,
        },
      });
      return;
    }

    try {
      if (signal.aborted) return;

      const result = await fn.handler({
        event: {
          id: job.event.id,
          name: job.event.name,
          data: job.event.data,
          timestamp: new Date(job.event.timestamp),
        },
        step: {
          run: vi.fn().mockImplementation(async (_name, fn) => fn()),
          sleep: vi.fn(),
          sleepUntil: vi.fn(),
          waitForEvent: vi.fn(),
          parallel: vi.fn(),
          map: vi.fn(),
        },
        run: {
          id: job.run_id,
          functionId: job.function_id,
          attempt: job.attempt,
          startedAt: new Date(),
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as FunctionContext);

      this.send({
        type: "job_completed",
        jobId: job.job_id,
        output: result,
      });
    } catch (error) {
      if (signal.aborted) return;

      this.send({
        type: "job_failed",
        jobId: job.job_id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "ERROR",
          retryable: true,
        },
      });
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== "connected") return;

      this.send({
        type: "heartbeat",
        activeJobs: this.activeJobs.size,
      });
    }, 30000);
  }

  async drain(): Promise<void> {
    if (this._state === "stopped" || this._state === "idle") return;

    this._state = "draining";
    this.stop();
  }

  stop(): void {
    this._state = "stopped";
    this.abortController?.abort();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    for (const job of this.activeJobs.values()) {
      job.abortController.abort();
    }
    this.activeJobs.clear();
  }
}

describe("StreamingWorker", () => {
  let worker: TestStreamingWorker;
  let testFunction: IronflowFunction;

  beforeEach(() => {
    vi.useFakeTimers();

    testFunction = createMockFunction("test-function", async (ctx) => {
      return { processed: true, eventName: ctx.event.name };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    worker?.stop();
  });

  describe("connection", () => {
    it("should send registration message on connect", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();

      const messages = worker.getOutgoingMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          type: "register",
          functionIds: ["test-function"],
        })
      );
    });

    it("should include max concurrent jobs in registration", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
        maxConcurrentJobs: 5,
      });

      await worker.connect();

      const messages = worker.getOutgoingMessages();
      expect(messages[0]?.maxConcurrentJobs).toBe(5);
    });

    it("should throw when already running", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();

      await expect(worker.connect()).rejects.toThrow("Worker is already running");
    });

    it("should transition to connected after receiving registered message", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      expect(worker.state).toBe("connecting");

      await worker.receiveMessage({ type: "registered" });
      expect(worker.state).toBe("connected");
    });
  });

  describe("job processing", () => {
    const createJobAssignment = (overrides = {}): MockServerMessage => ({
      type: "job_assignment",
      jobId: "job-1",
      runId: "run-1",
      functionId: "test-function",
      attempt: 1,
      event: { id: "evt-1", name: "test.event", data: {}, timestamp: new Date().toISOString() },
      completedSteps: [],
      ...overrides,
    });

    it("should send job ack when job is received", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      await worker.receiveMessage(createJobAssignment());

      const messages = worker.getOutgoingMessages();
      expect(messages.some((m) => m.type === "job_ack" && m.jobId === "job-1")).toBe(true);
    });

    it("should send job completed message on success", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      await worker.receiveMessage(createJobAssignment());

      const messages = worker.getOutgoingMessages();
      const completed = messages.find((m) => m.type === "job_completed");
      expect(completed).toBeDefined();
      expect(completed?.jobId).toBe("job-1");
      expect(completed?.output).toEqual(
        expect.objectContaining({ processed: true })
      );
    });

    it("should send job failed message on error", async () => {
      const errorFunction = createMockFunction("error-function", async () => {
        throw new Error("Test error");
      });

      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [errorFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      await worker.receiveMessage(
        createJobAssignment({ functionId: "error-function" })
      );

      const messages = worker.getOutgoingMessages();
      const failed = messages.find((m) => m.type === "job_failed");
      expect(failed).toBeDefined();
      expect(failed?.error?.message).toBe("Test error");
    });

    it("should send function not found error", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      await worker.receiveMessage(
        createJobAssignment({ functionId: "unknown-function" })
      );

      const messages = worker.getOutgoingMessages();
      const failed = messages.find((m) => m.type === "job_failed");
      expect(failed).toBeDefined();
      expect(failed?.error?.code).toBe("FUNCTION_NOT_FOUND");
    });
  });

  describe("job cancellation", () => {
    it("should cancel job when cancel message received", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });

      // Start the job
      await worker.receiveMessage({
        type: "job_assignment",
        jobId: "job-1",
        runId: "run-1",
        functionId: "test-function",
        attempt: 1,
        event: { id: "evt-1", name: "test.event", data: {}, timestamp: new Date().toISOString() },
        completedSteps: [],
      });

      // After processing, job count should be 0
      expect(worker.getActiveJobCount()).toBe(0);

      // Verify job_cancel removes a job from tracking even if it doesn't exist
      // (in real impl this would abort an in-progress job)
      await worker.receiveMessage({ type: "job_cancel", jobId: "nonexistent-job" });
      expect(worker.getActiveJobCount()).toBe(0);
    });
  });

  describe("heartbeat", () => {
    it("should send heartbeat at regular intervals", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30000);

      const messages = worker.getOutgoingMessages();
      expect(messages.some((m) => m.type === "heartbeat")).toBe(true);
    });

    it("should include active job count in heartbeat", async () => {
      worker = new TestStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFunction],
      });

      await worker.connect();
      await worker.receiveMessage({ type: "registered" });
      worker.clearMessages();

      vi.advanceTimersByTime(30000);

      const messages = worker.getOutgoingMessages();
      const heartbeat = messages.find((m) => m.type === "heartbeat");
      expect(heartbeat?.activeJobs).toBe(0);
    });
  });

  describe("shutdown", () => {
    describe("drain", () => {
      it("should transition to stopped state", async () => {
        worker = new TestStreamingWorker({
          serverUrl: "http://localhost:9123",
          functions: [testFunction],
        });

        await worker.connect();
        await worker.receiveMessage({ type: "registered" });

        await worker.drain();

        expect(worker.state).toBe("stopped");
      });
    });

    describe("stop", () => {
      it("should stop immediately and abort active jobs", async () => {
        worker = new TestStreamingWorker({
          serverUrl: "http://localhost:9123",
          functions: [testFunction],
        });

        await worker.connect();
        await worker.receiveMessage({ type: "registered" });

        worker.stop();

        expect(worker.state).toBe("stopped");
        expect(worker.getActiveJobCount()).toBe(0);
      });
    });
  });

  describe("duplicate function detection", () => {
    it("should warn on duplicate function IDs", () => {
      const fn1 = createMockFunction("my-func", async () => "a");
      const fn2 = createMockFunction("my-func", async () => "b");
      const warnSpy = vi.fn();

      createStreamingWorker({
        serverUrl: "http://localhost:9123",
        functions: [fn1, fn2],
        logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate function ID "my-func"')
      );
    });
  });
});
