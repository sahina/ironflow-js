/**
 * Ironflow Protocol Definitions
 *
 * WebSocket and HTTP protocol types for communication with the Ironflow server.
 */

import type { AckMode, AckType, BackpressureMode, EventMetadata } from "./types.js";

// ============================================================================
// Push Mode Protocol (HTTP)
// ============================================================================

/**
 * Request from engine to SDK (Push mode)
 */
export interface PushRequest {
  run_id: string;
  function_id: string;
  attempt: number;
  event: {
    id: string;
    name: string;
    data: unknown;
    timestamp: string;
    version?: number;
    idempotency_key?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  };
  steps: CompletedStep[];
  resume?: ResumeContext;
}

/**
 * A completed step from previous execution
 */
export interface CompletedStep {
  id: string;
  name: string;
  status: "completed" | "failed" | "timed_out";
  output?: unknown;
  error?: string;
}

/**
 * Resume context for sleep/waitForEvent/invoke_function
 */
export interface ResumeContext {
  step_id: string;
  type: "sleep" | "wait_for_event" | "invoke_function" | "invoke_function_async";
  data?: unknown;
}

/**
 * Response from SDK to engine (Push mode)
 */
export interface PushResponse {
  status: "completed" | "yielded" | "failed";
  steps: StepResult[];
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    step_id?: string;
    retryable: boolean;
    stack?: string;
  };
  yield?: YieldInfo;
}

/**
 * Result of a step execution
 */
export interface StepResult {
  id: string;
  name: string;
  type: "invoke" | "sleep" | "wait_for_event" | "compensate";
  status: "completed" | "failed";
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  output?: unknown;
  error?: {
    message: string;
    retryable: boolean;
    stack?: string;
  };
  compensation_for?: string;  // original step name this compensates
}

/**
 * Yield information for sleep/waitForEvent/invoke_function/invoke_function_async
 */
export type YieldInfo = SleepYield | WaitEventYield | InvokeFunctionYield | InvokeFunctionAsyncYield;

export interface SleepYield {
  step_id: string;
  type: "sleep";
  until: string;
}

export interface WaitEventYield {
  step_id: string;
  type: "wait_for_event";
  event_filter: {
    event: string;
    match?: string;
    timeout?: string;
  };
}

export interface InvokeFunctionYield {
  step_id: string;
  type: "invoke_function";
  function_id: string;
  input?: unknown;
  invoke_timeout_ms?: number;
}

export interface InvokeFunctionAsyncYield {
  step_id: string;
  type: "invoke_function_async";
  function_id: string;
  input?: unknown;
}

// ============================================================================
// WebSocket Protocol Types
// ============================================================================

/**
 * Subscribe request message sent to server
 */
export interface WSSubscribeRequest {
  type: "subscribe";
  subscription: {
    pattern: string;
    options?: {
      replay?: number;
      includeMetadata?: boolean;
      filter?: string;
      consumerGroup?: string;
      ackMode?: AckMode;
      backpressure?: BackpressureMode;
      namespace?: string;
    };
  };
}

/**
 * Unsubscribe request message sent to server
 */
export interface WSUnsubscribeRequest {
  type: "unsubscribe";
  subscriptionId: string;
}

/**
 * Acknowledgment request message sent to server
 */
export interface WSAckRequest {
  type: "ack";
  eventId: string;
  ackType: AckType;
  /** Delay in milliseconds before redelivery (for NAK) */
  redeliverDelay?: number;
}

/**
 * Subscription result message from server
 */
export interface WSSubscriptionResult {
  type: "subscription_result";
  results: Array<{
    pattern: string;
    status: "ok" | "error";
    subscriptionId?: string;
    code?: string;
    message?: string;
  }>;
}

/**
 * Event message from server
 */
export interface WSEventMessage {
  type: "event";
  subscriptionId: string;
  topic: string;
  data: unknown;
  meta?: EventMetadata;
  /** Event ID for consumer group ack/nak/term */
  eventId?: string;
}

/**
 * Subscription error message from server
 */
export interface WSSubscriptionError {
  type: "subscription_error";
  subscriptionId: string;
  code: string;
  message: string;
  retrying: boolean;
}

/**
 * General error message from server
 */
export interface WSError {
  type: "error";
  code: string;
  message: string;
}

/**
 * Union of all WebSocket messages from server
 */
export type WSServerMessage =
  | WSSubscriptionResult
  | WSEventMessage
  | WSSubscriptionError
  | WSError;

/**
 * Union of all WebSocket messages sent to server
 */
export type WSClientMessage =
  | WSSubscribeRequest
  | WSUnsubscribeRequest
  | WSAckRequest;

// ============================================================================
// Retry Event Information
// ============================================================================

/**
 * Retry event information passed to onRetry callback
 */
export interface RetryEvent {
  /** Current attempt number (1-based) */
  attempt: number;
  /** Maximum attempts configured */
  maxAttempts: number;
  /** The error that triggered the retry */
  error: Error;
  /** Delay before the next retry in ms */
  delayMs: number;
}

/**
 * Retry information for subscription events
 */
export interface RetryInfo {
  /** The event ID being retried */
  eventId: string;
  /** Current retry attempt number */
  attempt: number;
  /** Maximum retry attempts */
  maxAttempts: number;
  /** Delay until next retry in milliseconds */
  delayMs?: number;
}

// ============================================================================
// Client Configuration Types
// ============================================================================

/**
 * Retry configuration for client HTTP requests
 */
export interface ClientRetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms for server errors (default: 100) */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms (default: 10000) */
  maxDelayMs?: number;
  /** Backoff multiplier for server errors (default: 2.0) */
  backoffMultiplier?: number;
  /** Fixed delay for connection errors in ms (default: 2000) */
  connectionRetryDelayMs?: number;
  /** Callback invoked before each retry */
  onRetry?: (event: RetryEvent) => void;
}

// ============================================================================
// Pattern Helpers
// ============================================================================

/**
 * Helper functions for building common subscription patterns.
 *
 * Patterns use NATS-style wildcards:
 * - `*` matches a single token
 * - `>` matches one or more tokens (must be at end)
 */
export const patterns = {
  /** Subscribe to all run events */
  allRuns: () => "system.run.>",

  /** Subscribe to all events for a specific run */
  run: (runId: string) => `system.run.${runId}.>`,

  /** Subscribe to run lifecycle events only (created, updated, completed, failed) */
  runLifecycle: (runId: string) => `system.run.${runId}.*`,

  /** Subscribe to step events for a run */
  runSteps: (runId: string) => `system.run.${runId}.step.>`,

  /** Subscribe to all function events */
  allFunctions: () => "system.function.>",

  /** Subscribe to events for a specific function */
  function: (functionId: string) => `system.function.${functionId}.>`,

  /** Subscribe to a user event pattern */
  userEvent: (eventName: string) => `events:${eventName}`,

  /** Subscribe to all user events */
  allUserEvents: () => "events:>",

  /** Subscribe to all secret events (created, updated, deleted) */
  allSecrets: () => "system.secret.*",

  /** Subscribe to all events for a specific secret */
  secret: (name: string) => `system.secret.${name}.*`,

  /** Subscribe to a specific action across all secrets (e.g., "updated") */
  secretAction: (action: string) => `system.secret.*.${action}`,

  /** Subscribe to a developer pub/sub topic pattern */
  topic: (topicPattern: string) => `topic:${topicPattern}`,

  /** Subscribe to all developer pub/sub topics */
  allTopics: () => "topic:>",
} as const;
