/**
 * `ironflow.agents` namespace.
 *
 * Browser-facing helpers for `agent()` functions: fire-and-wait `invoke`,
 * typed `subscribe` for run/step events, and `readMemory` for typed
 * projection state reads.
 *
 * Spec: ./spec.md
 */

import type { Subscription } from "@ironflow/core";
import { invoke as agentInvoke } from "./invoke.js";
import { readMemory as agentReadMemory } from "./readMemory.js";
import { subscribe as agentSubscribe } from "./subscribe.js";
import type {
  AgentClientLike,
  AgentInvokeOptions,
  AgentInvokeResult,
  AgentMemoryResult,
  AgentReadMemoryOptions,
  AgentSubscribeCallbacks,
} from "./types.js";

export type {
  AgentClientLike,
  AgentInvokeOptions,
  AgentInvokeResult,
  AgentMemoryResult,
  AgentProgressEvent,
  AgentReadMemoryOptions,
  AgentStepEvent,
  AgentSubscribeCallbacks,
} from "./types.js";

/**
 * The shape exposed as `ironflow.agents`.
 */
export interface AgentSubscribeRuntimeOptions {
  /**
   * Number of historical events to replay on attach. Default: 1000.
   * Covers events emitted between `agents.invoke()` returning a runId
   * via `onRunStarted` and this subscribe attaching.
   */
  replay?: number;
}

export interface AgentsNamespace {
  invoke<TOutput = unknown>(
    name: string,
    payload: unknown,
    opts?: AgentInvokeOptions
  ): Promise<AgentInvokeResult<TOutput>>;

  subscribe(
    runId: string,
    callbacks: AgentSubscribeCallbacks,
    opts?: AgentSubscribeRuntimeOptions
  ): Promise<Subscription>;

  readMemory<TState = unknown>(
    projection: string,
    opts?: AgentReadMemoryOptions
  ): Promise<AgentMemoryResult<TState>>;
}

/**
 * Build the `agents` namespace bound to a specific client. Called by
 * the IronflowClient constructor.
 */
export function createAgentsNamespace(
  client: AgentClientLike
): AgentsNamespace {
  return {
    invoke: (name, payload, opts) => agentInvoke(client, name, payload, opts),
    subscribe: (runId, callbacks, opts) =>
      agentSubscribe(client, runId, callbacks, opts),
    readMemory: (projection, opts) => agentReadMemory(client, projection, opts),
  };
}
