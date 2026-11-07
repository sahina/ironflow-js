import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "@ironflow/core";
import { currentLogTrace } from "./tracing.js";

export interface LogCorrelation {
  run_id: string;
  function_id: string;
  step_id: string;
  attempt: number;
  trace_id: string;
}

type StepScope = { logger: Logger; stepId: string; active: boolean; parent?: StepScope };
const steps = new AsyncLocalStorage<StepScope>();

export async function withLogStep<T>(logger: Logger, stepId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const scope: StepScope = { logger, stepId, active: !signal?.aborted, parent: steps.getStore() };
  const expire = () => { scope.active = false; };
  signal?.addEventListener("abort", expire, { once: true });
  try {
    return await steps.run(scope, fn);
  } finally {
    expire();
    signal?.removeEventListener("abort", expire);
  }
}

function activeStep(scope: StepScope | undefined, logger: Logger): string {
  if (!scope || scope.logger !== logger) return "";
  for (let current: StepScope | undefined = scope; current; current = current.parent) {
    if (current.logger === logger && !current.active) return "";
  }
  return scope.stepId;
}

export function createExecutionLogger(identity: { runId: string; functionId: string; attempt: number }, sink: Logger): Logger {
  const emit = (level: keyof Logger, message: string, data?: Record<string, unknown>) => {
    const scope = steps.getStore();
    const correlation: LogCorrelation = {
      run_id: identity.runId,
      function_id: identity.functionId,
      step_id: activeStep(scope, logger),
      attempt: identity.attempt,
      trace_id: currentLogTrace().traceId,
    };
    sink[level](message, { ...data, ...correlation });
  };
  const logger: Logger = {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
  return logger;
}
