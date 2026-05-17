/**
 * agent() — entrypoint for durable AI agents.
 *
 * Wraps createFunction() with an extended handler context that carries
 * agent-shaped primitives (tool, llm, approve, memory, spawn). The
 * returned value is a plain IronflowFunction so existing serve() and
 * createWorker() register agents with zero changes.
 *
 * Runtime shape:
 *   - Per-run turn counter (drives ctx.turn + maxTurns enforcement).
 *   - Per-run tool registry built from AgentConfig.tools (drives by-name
 *     dispatch in ctx.tool(name, args) for LLM-driven tool calls).
 *   - Per-run byArgs idempotency cache for ctx.tool().
 *   - Per-run in-memory cache for memory.get() reads.
 *
 * All wrappers compose over ctx.step — agents inherit Ironflow's
 * crash-resume, replay, and audit semantics from the existing runtime.
 */

import type { z } from "zod";
import { IronflowClient } from "../client.js";
import { createFunction } from "../function.js";
import { makeApprove } from "./approve.js";
import { DuplicateToolError } from "./errors.js";
import { createTurnCounter, makeLlm } from "./llm.js";
import {
  type MemoryBackend,
  createMemoryRuntimeCache,
  createMemoryRuntimeCounters,
  makeMemory,
} from "./memory.js";
import { makeSpawn } from "./spawn.js";
import { createToolRuntime, makeTool } from "./tool.js";
import type {
  AgentConfig,
  AgentContext,
  AgentHandler,
  AnyToolDefinition,
  IronflowAgent,
} from "./types.js";

/** Default agent turn budget. Configurable via AgentConfig.maxTurns. */
const DEFAULT_MAX_TURNS = 20;

/**
 * Define a durable agent.
 *
 * When `config.memory` is set, the runtime constructs an IronflowClient
 * from `process.env.IRONFLOW_URL` (or `IRONFLOW_SERVER_URL`) plus
 * `IRONFLOW_API_KEY` for the memory backend. Workers that pass
 * `serverUrl` explicitly to `serve()` / `createWorker()` should also
 * export the matching env vars so memory operations resolve correctly.
 *
 * @example
 * ```ts
 * import { agent, defineTool } from "@ironflow/node/agent";
 * import { z } from "zod";
 *
 * const fetchDiff = defineTool({
 *   name: "fetch-diff",
 *   input: z.object({ pr: z.number() }),
 *   handler: async ({ pr }) => api.diff(pr),
 * });
 *
 * export const reviewAgent = agent(
 *   {
 *     id: "code-review",
 *     triggers: [{ event: "pr.opened" }],
 *     tools: [fetchDiff],
 *   },
 *   async ({ step, tool, llm, approve }) => {
 *     const diff = await tool(fetchDiff, { pr: event.data.prNumber });
 *     const findings = await llm.complete({
 *       messages: [{ role: "user", content: `Review:\n${diff}` }],
 *       call: () => myProvider.complete(...),
 *     });
 *     const decision = await approve("ship-it", { ttl: "24h", payload: findings });
 *     return { approved: decision.approved };
 *   }
 * );
 * ```
 */
export function agent<TEventSchema extends z.ZodType = z.ZodType<unknown>, TResult = unknown>(
  config: AgentConfig<TEventSchema>,
  handler: AgentHandler<z.infer<TEventSchema>, TResult>
): IronflowAgent<z.infer<TEventSchema>, TResult> {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const registry = buildRegistry(config.tools);

  return createFunction<TEventSchema, TResult>(config, async (ctx) => {
    const counter = createTurnCounter();
    const toolRuntime = createToolRuntime();
    const memoryCache = createMemoryRuntimeCache();
    const memoryCounters = createMemoryRuntimeCounters();
    const memoryBackend = config.memory ? createDefaultMemoryBackend() : undefined;

    const agentCtx: AgentContext<z.infer<TEventSchema>> = {
      event: ctx.event,
      step: ctx.step,
      run: ctx.run,
      logger: ctx.logger,
      secrets: ctx.secrets,
      tool: makeTool(ctx.step, registry, toolRuntime),
      llm: makeLlm(ctx.step, counter, maxTurns),
      approve: makeApprove(ctx.step, ctx.run.id),
      memory: makeMemory(
        ctx.step,
        config.memory,
        ctx.run.id,
        memoryCache,
        memoryBackend,
        memoryCounters
      ),
      spawn: makeSpawn(ctx.step),
      get turn() {
        return counter.value;
      },
    };

    return handler(agentCtx);
  });
}

/**
 * Construct the default MemoryBackend from environment variables.
 *
 * Reads IRONFLOW_URL / IRONFLOW_SERVER_URL for the server endpoint and
 * IRONFLOW_API_KEY for auth. Returns undefined when no URL is set so
 * makeMemory() can surface a clear "no backend" error on first use.
 */
function createDefaultMemoryBackend(): MemoryBackend | undefined {
  const serverUrl =
    process.env.IRONFLOW_URL ?? process.env.IRONFLOW_SERVER_URL;
  if (!serverUrl) return undefined;

  const client = new IronflowClient({
    serverUrl,
    apiKey: process.env.IRONFLOW_API_KEY,
  });

  return {
    appendEvent: (streamId, input) =>
      client.streams.append(
        streamId,
        { name: input.name, data: input.data, entityType: input.entityType },
        { idempotencyKey: input.idempotencyKey, metadata: input.metadata }
      ),
    getProjection: (name) => client.projections.get(name),
    waitForCatchup: async (name, opts) => {
      await client.projections.waitForCatchup(name, {
        minSeq: opts.minSeq,
        partition: opts.partition,
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}

function buildRegistry(
  tools: ReadonlyArray<AnyToolDefinition> | undefined
): ReadonlyMap<string, AnyToolDefinition> {
  const map = new Map<string, AnyToolDefinition>();
  if (!tools) return map;
  for (const def of tools) {
    if (map.has(def.name)) {
      throw new DuplicateToolError(def.name);
    }
    map.set(def.name, def);
  }
  return map;
}
