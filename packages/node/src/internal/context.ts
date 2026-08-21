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
 * Escape one segment of a composite step id.
 *
 * Step ids are `${runId}:${name}:${index}`, and a parallel branch scope is
 * `${runId}:${parallelName}:${branchIndex}`. Unescaped, a top-level step
 * literally named "a:0:b" at index 0 and a step named "b" at index 0 inside
 * parallel "a" branch 0 both render as `run:a:0:b:0` — two different steps
 * sharing one memoization key and one `steps` row (#1694 item 4).
 *
 * The step id is the memoization key on BOTH sides of the wire, so this must
 * stay byte-identical to escapeStepIDPart in sdk/go/ironflow/step.go. Names
 * containing neither ":" nor "\\" are returned unchanged, which is what keeps
 * ids stable for in-flight runs.
 */
export function escapeStepIdPart(part: string): string {
  for (const ns of STEP_ID_NAMESPACES) {
    if (part.startsWith(ns)) {
      return ns + escapeRaw(part.slice(ns.length));
    }
  }
  return escapeRaw(part);
}

/**
 * Prefixes the SDK itself prepends to a user-supplied name (step.publish,
 * compensation). They are structure, not user input: escaping their colon would
 * change the id of every existing publish and compensation step, so the first
 * resume after an upgrade would miss the memoized row and re-run the side
 * effect. Only the leaf after the prefix is escaped, which is enough — a branch
 * scope's index segment is always numeric, so the escaped leaf cannot line up
 * with one. Mirrors stepIDNamespaces in sdk/go/ironflow/step.go.
 */
const STEP_ID_NAMESPACES = ["compensate:", "publish:"];

function escapeRaw(part: string): string {
  return part.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

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
  /**
   * Called after each step is recorded. The pull worker uses it to schedule a
   * debounced checkpoint (#1670) so a killed worker does not lose completed
   * steps that only ever lived in the terminal update body. Unset in push mode.
   */
  onStepRecorded?: () => void;

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
    return this.preferLegacyStepId(
      `${this.runId}:${escapeStepIdPart(name)}:${index}`,
      `${this.runId}:${name}:${index}`
    );
  }

  /**
   * Bridge the escaping rollout (#1694 item 4).
   *
   * The step id is computed SDK-side, but completedSteps is indexed by whatever
   * id the server sent back — i.e. whatever a PRIOR invocation's SDK wrote. A run
   * that paused at a segment boundary (sleep / waitForEvent / invoke) before this
   * change shipped has rows keyed by the UNESCAPED name. After the deploy the
   * newly escaped id would miss that row and re-execute an already-completed step
   * for real: a double charge or a duplicate publish, once, at the upgrade
   * boundary, for exactly the colon-using names this fix targets.
   *
   * So: use the legacy id only when it is the one actually memoized. Names
   * without ":" or a backslash escape to themselves and never reach the lookup;
   * new runs have no legacy rows, so they always get the escaped id.
   * Mirrors preferLegacyStepID in sdk/go/ironflow/step.go.
   */
  preferLegacyStepId(id: string, legacy: string): string {
    if (legacy === id) return id;
    if (this.completedSteps.has(id)) return id;
    if (this.completedSteps.has(legacy)) return legacy;
    return id;
  }

  /**
   * Create a scoped context for a parallel branch
   */
  createBranchContext(parallelName: string, branchIndex: number): BranchContext {
    const scopePrefix = `${this.runId}:${escapeStepIdPart(parallelName)}:${branchIndex}`;
    const legacyScopePrefix = `${this.runId}:${parallelName}:${branchIndex}`;
    return new BranchContext(this, scopePrefix, legacyScopePrefix);
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
    this.onStepRecorded?.();
  }

  /**
   * One #1671 warning per distinct parallel/map name per invocation. Without
   * this, `step.map("outer", items, (i, s) => s.parallel("inner", ...))` emits
   * one "inner" line per item — a thousand identical lines, which is how a
   * warning gets filtered out and stops working. Keyed by name rather than a
   * single per-run flag so two genuinely different call sites still both
   * report.
   */
  private readonly warnedUnscopedNames = new Set<string>();

  shouldWarnUnscoped(name: string): boolean {
    if (this.warnedUnscopedNames.has(name)) return false;
    this.warnedUnscopedNames.add(name);
    return true;
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
  /**
   * scopePrefix built WITHOUT the #1694 name escaping, so a run that started
   * before escaping shipped still matches its already-persisted branch step ids
   * on resume. See ExecutionContext.preferLegacyStepId.
   */
  private readonly legacyScopePrefix: string;
  private stepCounters: Map<string, number> = new Map();
  /**
   * True once this branch used its scoped client — claimed a step id, or
   * opened a nested parallel/map. Deliberately narrower than "was durable":
   * a callback that reaches for the enclosing function's step client instead
   * still records real steps, they just land outside this branch's scope.
   * #1671 flags both, so this tracks use of the client, not durability.
   */
  private scopedClientUsed = false;

  get usedScopedClient(): boolean {
    return this.scopedClientUsed;
  }

  /**
   * executeParallel calls this on entry so a nested parallel/map counts even
   * when it has zero items — relying on createBranchContext instead misses
   * the empty-collection case and warns about a correct callback.
   */
  markScopedClientUsed(): void {
    this.scopedClientUsed = true;
  }

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

  constructor(parent: ExecutionContext, scopePrefix: string, legacyScopePrefix?: string) {
    this.parent = parent;
    this.scopePrefix = scopePrefix;
    this.legacyScopePrefix = legacyScopePrefix ?? scopePrefix;
  }

  generateStepId(name: string): string {
    this.scopedClientUsed = true;
    const index = this.stepCounters.get(name) ?? 0;
    this.stepCounters.set(name, index + 1);
    return this.parent.preferLegacyStepId(
      `${this.scopePrefix}:${escapeStepIdPart(name)}:${index}`,
      `${this.legacyScopePrefix}:${name}:${index}`
    );
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

  shouldWarnUnscoped(name: string): boolean {
    return this.parent.shouldWarnUnscoped(name);
  }

  createBranchContext(parallelName: string, branchIndex: number): BranchContext {
    const nestedPrefix = `${this.scopePrefix}:${escapeStepIdPart(parallelName)}:${branchIndex}`;
    const legacyNestedPrefix = `${this.legacyScopePrefix}:${parallelName}:${branchIndex}`;
    return new BranchContext(this.parent, nestedPrefix, legacyNestedPrefix);
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
