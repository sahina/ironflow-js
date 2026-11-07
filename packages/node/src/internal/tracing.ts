import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Span } from "@opentelemetry/api";
import { isYieldSignal } from "./errors.js";

type TraceCarrier = { traceparent?: string; tracestate?: string };
type TraceScope = { api: typeof import("@opentelemetry/api"); context: Context; span: Span };
const scopes = new AsyncLocalStorage<TraceScope>();
const apiPromise = import("@opentelemetry/api").catch(() => undefined);

function validTraceState(state: string | undefined): string | undefined {
  if (!state || state.length > 512) return undefined;
  const members = state.split(",");
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  for (const member of members) {
    const [key, value, extra] = member.trim().split("=");
    if (!key || !value || extra !== undefined || keys.has(key) || key.length > 256 ||
        !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(key) ||
        !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(value)) return undefined;
    keys.add(key);
  }
  return state;
}

function parentContext(api: TraceScope["api"], carrier?: TraceCarrier): Context {
  // Poll HTTP spans describe transport, not the producer of an assigned job.
  if (carrier?.traceparent && carrier.traceparent.length > 512) return api.ROOT_CONTEXT;
  const match = carrier?.traceparent?.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/);
  if (!match) return api.ROOT_CONTEXT;
  const [, version, traceId, spanId, flags, extra] = match;
  if (!version || !traceId || !spanId || !flags || version === "ff" ||
      (version === "00" && extra !== "") || (extra !== "" && !extra?.startsWith("-")) ||
      /^0+$/.test(traceId) || /^0+$/.test(spanId)) return api.ROOT_CONTEXT;
  const state = validTraceState(carrier?.tracestate);
  return api.trace.setSpanContext(api.ROOT_CONTEXT, {
    traceId, spanId, traceFlags: parseInt(flags, 16) & 1, isRemote: true,
    traceState: state ? api.createTraceState(state) : undefined,
  });
}

export function recordExecutionError(error: unknown): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.span.setStatus({ code: scope.api.SpanStatusCode.ERROR });
  // Exception messages can contain payloads, secrets, or credentials.
  scope.span.addEvent("exception", { "exception.type": error instanceof Error ? "Error" : "ThrownValue" });
}

async function inSpan<T>(scope: TraceScope, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    scope.span.end();
  };
  signal?.addEventListener("abort", end, { once: true });
  if (signal?.aborted) end();
  try {
    return await scopes.run(scope, () => scope.api.context.with(scope.context, fn));
  } catch (error) {
    if (!signal?.aborted && !isYieldSignal(error)) {
      scopes.run(scope, () => recordExecutionError(error));
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", end);
    end();
  }
}

export async function traceProcess<T>(carrier: TraceCarrier | undefined, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const api = await apiPromise;
  if (!api) return fn();
  const parent = parentContext(api, carrier);
  const span = api.trace.getTracer("@ironflow/node").startSpan("process", { kind: api.SpanKind.CONSUMER }, parent);
  return inSpan({ api, span, context: api.trace.setSpan(parent, span) }, signal, fn);
}

export async function traceStep<T>(name: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return fn();
  const span = scope.api.trace.getTracer("@ironflow/node").startSpan("step.run", {
    attributes: { "ironflow.step.name": name },
  }, scope.context);
  return inSpan({ ...scope, span, context: scope.api.trace.setSpan(scope.context, span) }, signal, fn);
}

export function currentLogTrace(): { context?: Context; traceId: string } {
  const scope = scopes.getStore();
  if (!scope) return { traceId: "" };
  const spanContext = scope.api.trace.getSpanContext(scope.context);
  return {
    context: scope.context,
    traceId: spanContext && scope.api.isSpanContextValid(spanContext) ? spanContext.traceId : "",
  };
}
