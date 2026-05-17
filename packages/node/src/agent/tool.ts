/**
 * tool() — durable, validated, idempotent tool invocation.
 *
 * Wraps step.run with:
 *   - Required Zod input validation (per CEO plan, JS-only)
 *   - Idempotency strategy: "byCall" (default) or "byArgs"
 *   - Per-tool timeout (default 60s)
 *
 * defineTool() is a pass-through factory that preserves the input/output
 * generic types for callers. The runtime call helper is constructed by
 * makeTool() and bound onto AgentContext.tool.
 */

import { createHash } from "node:crypto";
import type { StepClient } from "@ironflow/core";
import { ToolNotFoundError, ToolValidationError } from "./errors.js";
import { normalizeDuration } from "./internal.js";
import type { AnyToolDefinition, ToolDefinition, ToolFn } from "./types.js";

/** Default per-tool timeout when the definition does not specify one. */
const DEFAULT_TOOL_TIMEOUT = "60s";

/**
 * Per-run state shared by tool() invocations.
 *
 * byArgs idempotency reuses a single in-flight or resolved promise per
 * (tool name, args hash) pair, so concurrent or repeat calls with the
 * same args fold into one durable step.
 */
export interface ToolRuntime {
  readonly byArgsCache: Map<string, Promise<unknown>>;
}

/**
 * Define a tool. Pass-through factory that preserves the input/output
 * generic types. Tools are typically registered via AgentConfig.tools so
 * the agent can dispatch LLM-requested calls by name.
 */
export function defineTool<TInput, TOutput>(
  spec: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return spec;
}

/**
 * Build a ToolFn closure bound to the given step client and tool registry.
 *
 * Exported for use by agent.ts; not part of the public API surface.
 */
export function makeTool(
  step: StepClient,
  registry: ReadonlyMap<string, AnyToolDefinition>,
  runtime: ToolRuntime
): ToolFn {
  const tool = (async (
    defOrName: AnyToolDefinition | string,
    args: unknown
  ): Promise<unknown> => {
    const def = resolveDefinition(defOrName, registry);
    return invokeTool(step, def, args, runtime);
  }) as ToolFn;
  return tool;
}

function resolveDefinition(
  defOrName: AnyToolDefinition | string,
  registry: ReadonlyMap<string, AnyToolDefinition>
): AnyToolDefinition {
  if (typeof defOrName === "string") {
    const found = registry.get(defOrName);
    if (!found) {
      throw new ToolNotFoundError(defOrName);
    }
    return found;
  }
  return defOrName;
}

async function invokeTool(
  step: StepClient,
  def: AnyToolDefinition,
  args: unknown,
  runtime: ToolRuntime
): Promise<unknown> {
  const validated = validateInput(def, args);
  const timeout = normalizeDuration(def.timeout) ?? DEFAULT_TOOL_TIMEOUT;
  const idempotent = def.idempotent ?? "byCall";

  if (idempotent === "byArgs") {
    const hash = hashArgs(validated);
    const cacheKey = `${def.name}:${hash}`;
    const cached = runtime.byArgsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const promise = step.run(
      `tool.${def.name}.${hash}`,
      () => def.handler(validated),
      { timeout }
    );
    runtime.byArgsCache.set(cacheKey, promise);
    return promise;
  }

  return step.run(`tool.${def.name}`, () => def.handler(validated), { timeout });
}

function validateInput(def: AnyToolDefinition, args: unknown): unknown {
  const result = def.input.safeParse(args);
  if (!result.success) {
    throw new ToolValidationError(def.name, result.error.issues);
  }
  return result.data;
}

function hashArgs(args: unknown): string {
  const serialized = stableStringify(args);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/**
 * Stable-key JSON stringify so { a: 1, b: 2 } and { b: 2, a: 1 } hash to
 * the same value. Required for byArgs idempotency to behave intuitively
 * across calls that build args from object spreads in different orders.
 *
 * Objects exposing toJSON() (Date, custom serializers) defer to the host
 * JSON.stringify so different Dates do not collapse to the same hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Construct an empty ToolRuntime. Used by agent() per run. */
export function createToolRuntime(): ToolRuntime {
  return { byArgsCache: new Map() };
}
