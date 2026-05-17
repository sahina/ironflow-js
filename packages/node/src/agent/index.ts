/**
 * @ironflow/node/agent — durable agent primitives.
 *
 * The agent module is sugar over the existing step client. Each helper
 * (tool, llm, approve, memory, spawn) records durable steps under the
 * hood, so agents inherit Ironflow's crash-resume, replay, audit, and
 * scoped-injection semantics with no new server primitives.
 *
 * Anti-scope (locked in CEO + eng review):
 *   - No LLM provider router. Callers bring their own provider SDK and
 *     pass the provider call into llm() — the wrapper memoizes the result.
 *   - No prompt templating. Reasoning frameworks (LangGraph, Claude SDK,
 *     CrewAI) own that surface. Ironflow hosts them, not replaces them.
 *   - No graph execution. agent() runs a plain async handler.
 *
 * Public API:
 *
 *   import { agent, defineTool, exposeMcp } from "@ironflow/node/agent";
 *
 *   // tool / llm / approve / memory / spawn are ctx-injected helpers,
 *   // destructured inside the agent handler:
 *   agent({ id: "..." }, async ({ step, tool, llm, approve, memory, spawn }) => {
 *     // ...
 *   });
 *
 * See docs/explanation/comparison-agents.md for the layering model.
 */

export type {
  AgentConfig,
  AgentContext,
  AgentHandler,
  ApproveFn,
  ApproveOptions,
  ApproveResult,
  ExposeMcpConfig,
  IronflowAgent,
  LLMClient,
  LLMCompleteRequest,
  LLMCompleteResult,
  McpToolDef,
  MemoryAppendOptions,
  MemoryClient,
  MemoryGetOptions,
  MemoryConfig,
  SpawnFn,
  SpawnOptions,
  SpawnResult,
  AnyToolDefinition,
  ToolDefinition,
  ToolFn,
  ToolIdempotency,
} from "./types.js";

export {
  DuplicateToolError,
  LLMError,
  LLMInvalidJSONError,
  LLMMaxTokensError,
  LLMRefusalError,
  MaxTurnsExceededError,
  MemoryProjectionRequiredError,
  ToolNotFoundError,
  ToolValidationError,
} from "./errors.js";

export { agent } from "./agent.js";
export { defineTool } from "./tool.js";
export { exposeMcp } from "./mcp.js";
export type { ExposeMcpHandle } from "./mcp.js";
export type { MemoryBackend } from "./memory.js";
