/**
 * Internal Execution Context
 *
 * Manages step memoization and resume state during function execution.
 */

import type {
  IronflowEvent,
  Logger,
  RunInfo,
  PushRequest,
  CompletedStep,
  ResumeContext,
  StepResult,
  EventDefinitionRegistry,
} from "@ironflow/core";

/**
 * Execution context for a function invocation
 */
export class ExecutionContext {
  /** The run ID */
  readonly runId: string;
  /** The function ID */
  readonly functionId: string;
  /** Current attempt number */
  readonly attempt: number;
  /** The triggering event */
  readonly event: IronflowEvent;
  /** Run information */
  readonly runInfo: RunInfo;
  /** Logger instance */
  readonly logger: Logger;

  /** Step counters for generating unique step IDs */
  private stepCounters: Map<string, number> = new Map();
  /** Completed steps from previous execution (memoized) */
  private completedSteps: Map<string, CompletedStep> = new Map();
  /** Steps executed in this invocation */
  private executedSteps: StepResult[] = [];
  /** Resume context for sleep/waitForEvent */
  private resumeContext?: ResumeContext;
  /** Whether we've processed the resume */
  private resumeProcessed = false;
  /** Compensation registry: step name -> compensation function */
  private compensationRegistry: Map<string, () => Promise<void>> = new Map();
  /** Ordered list of step names that have compensations registered */
  private compensationOrder: string[] = [];
  /** Function-level default step timeout */
  readonly stepTimeout?: string;
  /** Server URL for steps that need to call back to the server (e.g., publish) */
  readonly serverUrl?: string;
  /** API key for authenticated requests from steps */
  readonly apiKey?: string;

  constructor(request: PushRequest, logger?: Logger, eventDefinitions?: EventDefinitionRegistry, stepTimeout?: string, serverUrl?: string, apiKey?: string) {
    this.runId = request.run_id;
    this.functionId = request.function_id;
    this.attempt = request.attempt;

    // Parse event
    const eventVersion = request.event.version ?? 1;
    let eventData = request.event.data;

    // Apply upcasting if registry is provided
    if (eventDefinitions) {
      eventData = eventDefinitions.upcastEvent(request.event.name, eventData, eventVersion);
    }

    this.event = {
      id: request.event.id,
      name: request.event.name,
      version: eventVersion,
      data: eventData,
      timestamp: new Date(request.event.timestamp),
      idempotencyKey: request.event.idempotency_key,
      source: request.event.source,
      metadata: request.event.metadata,
    };

    // Build run info
    this.runInfo = {
      id: this.runId,
      functionId: this.functionId,
      attempt: this.attempt,
      startedAt: new Date(),
    };

    // Store completed steps for memoization
    for (const step of request.steps) {
      this.completedSteps.set(step.id, step);
    }

    // Store resume context
    this.resumeContext = request.resume;

    // Use provided logger or create default
    this.logger = logger ?? createDefaultLogger(this.runId);

    this.stepTimeout = stepTimeout;
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
  }

  /**
   * Generate a unique step ID
   */
  generateStepId(name: string): string {
    const index = this.stepCounters.get(name) ?? 0;
    this.stepCounters.set(name, index + 1);
    return `${this.runId}:${name}:${index}`;
  }

  /**
   * Create a scoped context for a parallel branch
   */
  createBranchContext(parallelName: string, branchIndex: number): BranchContext {
    const scopePrefix = `${this.runId}:${parallelName}:${branchIndex}`;
    return new BranchContext(this, scopePrefix);
  }

  /**
   * Check if a step is already completed (memoized)
   */
  getCompletedStep(stepId: string): CompletedStep | undefined {
    return this.completedSteps.get(stepId);
  }

  /**
   * Check if we should skip step execution due to memoization
   */
  shouldSkipStep(stepId: string): boolean {
    const completed = this.completedSteps.get(stepId);
    return completed?.status === "completed";
  }

  /**
   * Get the error data for a failed step, if it exists.
   * Returns undefined if the step is not failed or not present.
   */
  getFailedStep(stepId: string): unknown | undefined {
    const step = this.completedSteps.get(stepId);
    if (step?.status !== "failed") {
      return undefined;
    }
    if (typeof step.error === "string") {
      try {
        return JSON.parse(step.error);
      } catch {
        return step.error;
      }
    }
    return step.error;
  }

  /**
   * Check if a step has status "timed_out"
   */
  isStepTimedOut(stepId: string): boolean {
    const step = this.completedSteps.get(stepId);
    return step?.status === "timed_out";
  }

  /**
   * Get the memoized output for a step
   */
  getMemoizedOutput<T>(stepId: string): T | undefined {
    const completed = this.completedSteps.get(stepId);
    if (completed?.status === "completed") {
      return completed.output as T;
    }
    return undefined;
  }

  /**
   * Check if we're resuming from a specific step
   */
  isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean {
    if (!this.resumeContext) {
      return false;
    }
    return (
      this.resumeContext.step_id === stepId && this.resumeContext.type === type
    );
  }

  /**
   * Get the resume data (for waitForEvent)
   */
  getResumeData<T>(): T | undefined {
    return this.resumeContext?.data as T | undefined;
  }

  /**
   * Mark the resume as processed
   */
  markResumeProcessed(): void {
    this.resumeProcessed = true;
  }

  /**
   * Check if the resume has been processed
   */
  hasResumeBeenProcessed(): boolean {
    return this.resumeProcessed;
  }

  /**
   * Record a step execution result
   */
  recordStep(step: StepResult): void {
    this.executedSteps.push(step);
  }

  /**
   * Get all steps executed in this invocation
   */
  getExecutedSteps(): StepResult[] {
    return [...this.executedSteps];
  }

  /**
   * Register a compensation handler for a step
   */
  registerCompensation(stepName: string, fn: () => Promise<void>): void {
    if (this.compensationRegistry.has(stepName)) {
      throw new Error(`Compensation already registered for step: ${stepName}`);
    }
    this.compensationRegistry.set(stepName, fn);
    this.compensationOrder.push(stepName);
  }

  /**
   * Get compensations in reverse registration order
   */
  getCompensationsInReverse(): Array<{ stepName: string; fn: () => Promise<void> }> {
    const reversed = [...this.compensationOrder].reverse();
    return reversed
      .map((stepName) => {
        const fn = this.compensationRegistry.get(stepName);
        return fn ? { stepName, fn } : null;
      })
      .filter((entry): entry is { stepName: string; fn: () => Promise<void> } => entry !== null);
  }

  /**
   * Check if any compensations are registered
   */
  hasCompensations(): boolean {
    return this.compensationOrder.length > 0;
  }
}

/**
 * A scoped context for parallel branch execution
 */
export class BranchContext {
  private readonly parent: ExecutionContext;
  private readonly scopePrefix: string;
  private stepCounters: Map<string, number> = new Map();

  get logger(): Logger {
    return this.parent.logger;
  }

  get runId(): string {
    return this.parent.runId;
  }

  get serverUrl(): string | undefined {
    return this.parent.serverUrl;
  }

  get apiKey(): string | undefined {
    return this.parent.apiKey;
  }

  constructor(parent: ExecutionContext, scopePrefix: string) {
    this.parent = parent;
    this.scopePrefix = scopePrefix;
  }

  generateStepId(name: string): string {
    const index = this.stepCounters.get(name) ?? 0;
    this.stepCounters.set(name, index + 1);
    return `${this.scopePrefix}:${name}:${index}`;
  }

  shouldSkipStep(stepId: string): boolean {
    return this.parent.shouldSkipStep(stepId);
  }

  getFailedStep(stepId: string): unknown | undefined {
    return this.parent.getFailedStep(stepId);
  }

  isStepTimedOut(stepId: string): boolean {
    return this.parent.isStepTimedOut(stepId);
  }

  getMemoizedOutput<T>(stepId: string): T | undefined {
    return this.parent.getMemoizedOutput<T>(stepId);
  }

  isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean {
    return this.parent.isResumingFrom(stepId, type);
  }

  getResumeData<T>(): T | undefined {
    return this.parent.getResumeData<T>();
  }

  markResumeProcessed(): void {
    this.parent.markResumeProcessed();
  }

  recordStep(step: StepResult): void {
    this.parent.recordStep(step);
  }

  createBranchContext(parallelName: string, branchIndex: number): BranchContext {
    const nestedPrefix = `${this.scopePrefix}:${parallelName}:${branchIndex}`;
    return new BranchContext(this.parent, nestedPrefix);
  }

  registerCompensation(stepName: string, fn: () => Promise<void>): void {
    this.parent.registerCompensation(stepName, fn);
  }

  getCompensationsInReverse(): Array<{ stepName: string; fn: () => Promise<void> }> {
    return this.parent.getCompensationsInReverse();
  }

  hasCompensations(): boolean {
    return this.parent.hasCompensations();
  }
}

/**
 * Create a default logger that logs to console
 */
function createDefaultLogger(runId: string): Logger {
  const prefix = `[ironflow:${runId.slice(-8)}]`;

  return {
    debug(message: string, data?: Record<string, unknown>): void {
      if (process.env["IRONFLOW_DEBUG"]) {
        // eslint-disable-next-line no-console
        console.debug(prefix, message, data ?? "");
      }
    },
    info(message: string, data?: Record<string, unknown>): void {
      // eslint-disable-next-line no-console
      console.info(prefix, message, data ?? "");
    },
    warn(message: string, data?: Record<string, unknown>): void {
      // eslint-disable-next-line no-console
      console.warn(prefix, message, data ?? "");
    },
    error(message: string, data?: Record<string, unknown>): void {
      // eslint-disable-next-line no-console
      console.error(prefix, message, data ?? "");
    },
  };
}
