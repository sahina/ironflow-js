/**
 * Agent module error classes.
 *
 * All extend IronflowError. Codes are stable for programmatic handling.
 */

import { IronflowError } from "@ironflow/core";

/**
 * Thrown when an agent exceeds its configured turn budget.
 *
 * Default budget is 20 turns. Configurable via AgentConfig.maxTurns.
 */
export class MaxTurnsExceededError extends IronflowError {
  constructor(maxTurns: number, options?: { cause?: Error }) {
    super(`agent exceeded maxTurns (${maxTurns})`, {
      code: "AGENT_MAX_TURNS_EXCEEDED",
      retryable: false,
      details: { maxTurns },
      cause: options?.cause,
    });
    this.name = "MaxTurnsExceededError";
  }
}

/**
 * Base class for classified LLM errors emitted by llm().
 */
export class LLMError extends IronflowError {
  constructor(
    message: string,
    options: {
      code: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, options);
    this.name = "LLMError";
  }
}

/**
 * Provider refused the request (safety, policy, etc.).
 */
export class LLMRefusalError extends LLMError {
  constructor(message: string, options?: { details?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      code: "LLM_REFUSAL",
      retryable: false,
      details: options?.details,
      cause: options?.cause,
    });
    this.name = "LLMRefusalError";
  }
}

/**
 * Provider returned content that failed JSON parsing when JSON was required.
 */
export class LLMInvalidJSONError extends LLMError {
  constructor(message: string, options?: { details?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      code: "LLM_INVALID_JSON",
      retryable: true,
      details: options?.details,
      cause: options?.cause,
    });
    this.name = "LLMInvalidJSONError";
  }
}

/**
 * Provider truncated the response by hitting max_tokens.
 */
export class LLMMaxTokensError extends LLMError {
  constructor(message: string, options?: { details?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      code: "LLM_MAX_TOKENS",
      retryable: false,
      details: options?.details,
      cause: options?.cause,
    });
    this.name = "LLMMaxTokensError";
  }
}

/**
 * Thrown when tool() input fails Zod validation.
 *
 * Distinct from generic ValidationError so callers can differentiate
 * agent-tool input failures from event-payload schema failures.
 */
export class ToolValidationError extends IronflowError {
  constructor(
    toolName: string,
    issues: unknown,
    options?: { cause?: Error }
  ) {
    super(`tool "${toolName}" input validation failed`, {
      code: "AGENT_TOOL_VALIDATION",
      retryable: false,
      details: { toolName, issues },
      cause: options?.cause,
    });
    this.name = "ToolValidationError";
  }
}

/**
 * Thrown when AgentConfig.tools contains two or more definitions sharing
 * the same name. Silent overwrite would let LLM-driven dispatch route to
 * an unintended handler — so we fail loudly at agent construction.
 */
export class DuplicateToolError extends IronflowError {
  constructor(toolName: string) {
    super(`duplicate tool "${toolName}" registered on AgentConfig.tools`, {
      code: "AGENT_DUPLICATE_TOOL",
      retryable: false,
      details: { toolName },
    });
    this.name = "DuplicateToolError";
  }
}

/**
 * Thrown when ctx.tool(name, args) is called with a name that isn't
 * registered on AgentConfig.tools.
 */
export class ToolNotFoundError extends IronflowError {
  constructor(toolName: string) {
    super(
      `tool "${toolName}" not registered on AgentConfig.tools — register it or call by reference`,
      {
        code: "AGENT_TOOL_NOT_FOUND",
        retryable: false,
        details: { toolName },
      }
    );
    this.name = "ToolNotFoundError";
  }
}

/**
 * Thrown when memory.entityStream() is called without a projection.
 *
 * Per architecture decision: raw event replay is not exposed through
 * the agent memory API. Consumers must define a projection.
 */
export class MemoryProjectionRequiredError extends IronflowError {
  constructor(streamId: string) {
    super(
      `memory.entityStream("${streamId}") requires a projection — raw replay is not exposed via the agent API`,
      {
        code: "AGENT_MEMORY_PROJECTION_REQUIRED",
        retryable: false,
        details: { streamId },
      }
    );
    this.name = "MemoryProjectionRequiredError";
  }
}
