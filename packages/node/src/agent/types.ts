/**
 * Agent module type definitions.
 *
 * AgentContext extends the standard FunctionContext with agent-shaped
 * primitives (tool, llm, approve, memory, spawn). Wrappers compose
 * on top of the existing step client — no new server primitives.
 */

import type {
  Duration,
  FunctionConfig,
  FunctionContext,
  IronflowEvent,
  IronflowFunction,
  Logger,
  RunInfo,
  SecretsClient,
  StepClient,
} from "@ironflow/core";
import type { z } from "zod";

// ============================================================================
// tool() — definition + invocation
// ============================================================================

/**
 * Idempotency strategy for tool() calls.
 *
 * - "byCall": each tool() invocation memoizes by call-site (default).
 *   Matches existing step.run semantics — same call, same memoized result.
 * - "byArgs": memoize by SHA-256 hash of input args. Subsequent calls with
 *   the same input return the cached result, even from different call sites.
 */
export type ToolIdempotency = "byCall" | "byArgs";

/**
 * A tool definition produced by defineTool().
 *
 * Tools are registered on AgentConfig.tools so the agent can dispatch
 * LLM-requested tool calls by name. Definitions are also callable
 * directly via ctx.tool(def, args) for type-safe invocation.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Unique tool name (used for LLM dispatch). */
  readonly name: string;
  /** Optional human-readable description (surfaced to LLMs and MCP). */
  readonly description?: string;
  /** Required Zod schema for input validation. */
  readonly input: z.ZodType<TInput>;
  /** Idempotency strategy. Default: "byCall". */
  readonly idempotent?: ToolIdempotency;
  /** Per-tool timeout. Default: 60s. */
  readonly timeout?: Duration;
  /** Tool implementation. */
  readonly handler: (input: TInput) => Promise<TOutput>;
}

/**
 * Erased generic alias for arrays/registries holding tools of mixed
 * narrow input/output types. Use in container positions (e.g.
 * AgentConfig.tools) where TS array invariance otherwise rejects narrow
 * subtypes.
 */
export type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * The tool helper available on AgentContext.
 *
 * Has two call shapes:
 *   - by reference: tool(def, args) — type-safe, returns def's output type
 *   - by name:      tool(name, args) — for LLM-driven dispatch, returns unknown
 *
 * Both wrap step.run with Zod validation, idempotency keying, and timeout
 * enforcement. The by-name form requires the tool to be registered via
 * AgentConfig.tools.
 */
export interface ToolFn {
  <TInput, TOutput>(
    def: ToolDefinition<TInput, TOutput>,
    args: TInput
  ): Promise<TOutput>;
  (name: string, args: unknown): Promise<unknown>;
}

// ============================================================================
// llm()
// ============================================================================

/**
 * Provider-agnostic completion request.
 *
 * The llm() wrapper is sugar — it does not own a provider router. Callers
 * pass a provider call (closure) that does the actual API call. The wrapper
 * memoizes the result and classifies known failure modes.
 */
export interface LLMCompleteRequest {
  /** Conversation messages. Provider-shape-agnostic. */
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  /** Optional tool definitions for function-calling providers. */
  tools?: ReadonlyArray<{ name: string; description?: string; input?: unknown }>;
  /**
   * Provider call closure. Must return a normalized LLMCompleteResult.
   *
   * The wrapper memoizes the closure's resolved value as a step. The
   * closure is responsible for the actual provider call and for mapping
   * provider-specific shapes onto LLMCompleteResult.
   */
  call: () => Promise<LLMCompleteResult>;
  /** Optional provider-passthrough metadata (model, temperature, …). */
  options?: Record<string, unknown>;
}

/**
 * Result of an llm() call.
 *
 * Shape is provider-agnostic. Callers narrow as needed.
 */
export interface LLMCompleteResult {
  /** Raw assistant message content. */
  content?: unknown;
  /** Tool calls requested by the model, if any. */
  toolCalls?: ReadonlyArray<{ name: string; input: unknown }>;
  /**
   * Optional finish reason hint. When set, the wrapper inspects it to
   * raise classified errors:
   *   - "refusal" → LLMRefusalError
   *   - "max_tokens" / "length" → LLMMaxTokensError
   * Anything else passes through.
   */
  finishReason?: string;
  /** Provider-passthrough metadata (usage, raw, …). */
  metadata?: Record<string, unknown>;
}

/**
 * The llm client surface exposed to handlers.
 */
export interface LLMClient {
  /** Run a memoized completion. Increments the agent turn counter. */
  complete(request: LLMCompleteRequest): Promise<LLMCompleteResult>;
}

// ============================================================================
// approve()
// ============================================================================

/**
 * Options for approve().
 */
export interface ApproveOptions<TPayload = unknown> {
  /** Time to wait for the approval event before timing out. */
  ttl: Duration;
  /** Payload to attach to the pending approval (visible to approvers). */
  payload?: TPayload;
}

/**
 * Result of approve().
 *
 * approved=false on timeout. The handler can distinguish timeout vs
 * explicit rejection by inspecting the reason field.
 */
export interface ApproveResult<TPayload = unknown> {
  /** Whether the request was approved. */
  approved: boolean;
  /** User who approved/rejected, if recorded by the approver. */
  approver?: string;
  /** Payload echoed back from the approval event. */
  payload?: TPayload;
  /** Optional reason supplied by the approver, or "timeout". */
  reason?: string;
}

/**
 * Approval helper.
 */
export type ApproveFn = <TPayload = unknown, TResult = unknown>(
  name: string,
  options: ApproveOptions<TPayload>
) => Promise<ApproveResult<TResult>>;

// ============================================================================
// memory()
// ============================================================================

/**
 * Options for memory.get().
 */
export interface MemoryGetOptions {
  /**
   * Disable the in-run cache for this read. Default: false (cache on).
   *
   * Cache invalidates on own writes within the same run.
   */
  bypassCache?: boolean;
}

/**
 * Options for memory.append().
 */
export interface MemoryAppendOptions {
  /** Optional metadata attached to the appended event. */
  metadata?: Record<string, unknown>;
}

/**
 * Memory client.
 *
 * Wraps an entity stream keyed by the agent run. memory.entityStream()
 * requires a projection — raw replay is not exposed.
 */
export interface MemoryClient {
  /**
   * Read the projected memory state.
   *
   * Returns undefined if the projection has no record for this run.
   */
  get<T = unknown>(options?: MemoryGetOptions): Promise<T | undefined>;

  /** Append a memory event (durable). */
  append<T = unknown>(eventName: string, data: T, options?: MemoryAppendOptions): Promise<void>;

  /**
   * Open a projection-backed entity stream view.
   *
   * Throws MemoryProjectionRequiredError if no projection name is supplied.
   */
  entityStream<T = unknown>(streamId: string, projectionName: string): Promise<T | undefined>;
}

/**
 * Configuration for the memory client.
 *
 * Memory is opt-in per agent: callers wire a streamId + projection name
 * via AgentConfig.memory.
 */
export interface MemoryConfig {
  /** Entity stream ID for this agent's memory. */
  streamId: string;
  /** Projection name used by memory.get(). */
  projection: string;
  /**
   * Entity type recorded with appended events. Informational on the
   * server side; surfaces in audit/admin views. Defaults to "agent".
   */
  entityType?: string;
}

// ============================================================================
// spawn()
// ============================================================================

/**
 * Options for spawn().
 */
export interface SpawnOptions<TInput = unknown> {
  /** Function ID to invoke as a sub-agent. */
  functionId: string;
  /** Input event payload for the sub-agent. */
  input: TInput;
  /** Whether to wait for completion. Default: true. */
  await?: boolean;
}

/**
 * Result of a spawn() call.
 *
 * Field availability depends on the await mode:
 *   - await=true (default): output is the resolved sub-agent value;
 *     runId is omitted because step.invoke does not return the run ID.
 *   - await=false: runId is present (from step.invokeAsync); output is
 *     omitted because the caller did not wait for completion.
 */
export interface SpawnResult<TOutput = unknown> {
  /** Sub-run ID (for log/audit correlation). Present when await=false. */
  runId?: string;
  /** Sub-agent output. Present when await=true. */
  output?: TOutput;
}

/**
 * Spawn helper.
 */
export type SpawnFn = <TInput = unknown, TOutput = unknown>(
  name: string,
  options: SpawnOptions<TInput>
) => Promise<SpawnResult<TOutput>>;

// ============================================================================
// exposeMcp()
// ============================================================================

/**
 * Definition of a single MCP-exposed tool.
 *
 * Note: client-side scope hints are advisory. Authoritative authorization
 * is enforced server-side via api_keys + tool_scopes. See the agent-runtime
 * licensing docs for the auth model.
 */
export interface McpToolDef<TInput = unknown, TOutput = unknown> {
  /** Tool name as exposed via MCP. */
  name: string;
  /** Human-readable description for MCP clients. */
  description: string;
  /** Zod input schema. */
  input: z.ZodType<TInput>;
  /** Optional Zod output schema (recommended). */
  output?: z.ZodType<TOutput>;
  /** Required scope strings for server-side RBAC. Hint to clients only. */
  scopes?: ReadonlyArray<string>;
  /** Tool implementation. */
  handler: (input: TInput) => Promise<TOutput>;
}

/**
 * Erased generic alias for arrays/registries holding MCP tools of mixed
 * narrow input/output types. Use in container positions where TS array
 * invariance otherwise rejects narrow McpToolDef subtypes (issue #634).
 */
export type AnyMcpToolDef = McpToolDef<any, any>;

/**
 * Configuration for exposeMcp().
 *
 * `name` doubles as the agent namespace surfaced to MCP clients
 * (qualified tool name = `${name}.${tool.name}`). The Ironflow server
 * uses it as the registry key — calling exposeMcp() twice with the
 * same name from the same API key rotates the HMAC secret.
 */
export interface ExposeMcpConfig {
  /** Agent namespace + server name reported via MCP initialize. */
  name: string;
  /** Server version. */
  version: string;
  /** Tool registry. */
  tools: ReadonlyArray<AnyMcpToolDef>;
  /**
   * Public URL the Ironflow server will POST signed dispatch requests to.
   * Must point at the same `serve()` mount that hosts your push functions —
   * the mount appends `/ironflow/agent-tools/dispatch` and verifies HMAC.
   *
   * Required. No env fallback: the public URL is deployment-specific and
   * cannot be inferred at runtime.
   */
  callbackUrl: string;
  /**
   * Ironflow control-plane URL. Defaults to `IRONFLOW_URL` then
   * `IRONFLOW_SERVER_URL` env vars.
   */
  serverUrl?: string;
  /**
   * API key used to call AgentToolsService/RegisterTool. The key must
   * hold the `agent:tools:register` action. Defaults to
   * `IRONFLOW_API_KEY` env var.
   */
  apiKey?: string;
}

// ============================================================================
// agent() configuration + context
// ============================================================================

/**
 * Configuration for an agent.
 *
 * Extends FunctionConfig with:
 *   - tools: ToolDefinition[] — registry for ctx.tool(name, args) dispatch
 *   - memory: MemoryConfig — opt-in durable memory
 *   - maxTurns: number — turn budget (default 20)
 */
export interface AgentConfig<TEventSchema extends z.ZodType = z.ZodType>
  extends FunctionConfig<TEventSchema> {
  /** Tool definitions available for LLM-driven dispatch. */
  tools?: ReadonlyArray<AnyToolDefinition>;
  /** Durable memory configuration. */
  memory?: MemoryConfig;
  /**
   * Maximum number of agent turns (llm() calls) before
   * MaxTurnsExceededError is raised. Default: 20.
   */
  maxTurns?: number;
}

/**
 * Context passed to agent handlers.
 *
 * Extends FunctionContext with tool/llm/approve/memory/spawn helpers.
 * All helpers compose over the underlying StepClient — they record
 * durable steps under the hood.
 */
export interface AgentContext<TEvent = unknown> extends FunctionContext<TEvent> {
  /** Standard fields from FunctionContext (re-asserted for IDE clarity). */
  readonly event: IronflowEvent<TEvent>;
  readonly step: StepClient;
  readonly run: RunInfo;
  readonly logger: Logger;
  readonly secrets: SecretsClient;

  /** Run a tool. Wraps step.run with Zod validation, idempotency, timeout. */
  readonly tool: ToolFn;

  /** Run an LLM call. Memoized step with classified error surface. */
  readonly llm: LLMClient;

  /** Wait for a human approval event. */
  readonly approve: ApproveFn;

  /** Read/write durable agent memory. */
  readonly memory: MemoryClient;

  /** Spawn a sub-agent. */
  readonly spawn: SpawnFn;

  /**
   * Number of llm() turns consumed so far in this run (read-only).
   *
   * Incremented before each llm() call. Comparison against
   * config.maxTurns drives MaxTurnsExceededError.
   */
  readonly turn: number;
}

/**
 * Agent handler signature.
 */
export type AgentHandler<TEvent = unknown, TResult = unknown> = (
  ctx: AgentContext<TEvent>
) => Promise<TResult>;

/**
 * An agent is a specialized IronflowFunction whose handler accepts an
 * AgentContext. It registers like any other function — `serve()` and
 * `createWorker()` need no agent-specific awareness.
 */
export type IronflowAgent<TEvent = unknown, TResult = unknown> = IronflowFunction<TEvent, TResult>;
