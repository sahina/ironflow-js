/**
 * Node.js-specific type definitions
 */

import type { AnyIronflowFunction, IronflowProjection, IronflowWebhook, Logger, FunctionConfig, EventDefinitionRegistry } from "@ironflow/core";

// ============================================================================
// Serve Configuration (Push mode)
// ============================================================================

/**
 * Configuration for the serve handler
 */
export interface ServeConfig {
  /** Functions to serve */
  functions: AnyIronflowFunction[];
  /** Projections to register */
  projections?: IronflowProjection[];
  /** Signing key for webhook verification */
  signingKey?: string;
  /** Skip signature verification (dev only) */
  skipVerification?: boolean;
  /** Logger instance (or false to disable) */
  logger?: Logger | false;
  /** Target environment (default: IRONFLOW_ENV or "default") */
  environment?: string;
  /** Event definition registry for automatic upcasting of event data */
  eventDefinitions?: EventDefinitionRegistry;
  /** Ironflow server URL for emitting webhook events */
  serverUrl?: string;
  /** Webhook sources to handle */
  webhooks?: IronflowWebhook[];
}

/**
 * Handler options for incoming requests
 */
export interface HandlerOptions {
  /** Override signing key per-request */
  signingKey?: string;
}

/**
 * Context available in the handler
 */
export interface HandlerContext {
  /** Raw request body */
  rawBody: string;
  /** Signature from headers */
  signature?: string;
}

// ============================================================================
// Worker Configuration (Pull mode)
// ============================================================================

/**
 * Configuration for pull mode worker
 */
export interface WorkerConfig {
  /** Ironflow server URL */
  serverUrl?: string;
  /** Functions this worker handles */
  functions: AnyIronflowFunction[];
  /** Projections to register */
  projections?: IronflowProjection[];
  /** Maximum concurrent jobs (default: 10) */
  maxConcurrentJobs?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Reconnect delay in ms (default: 5000) */
  reconnectDelay?: number;
  /** Worker labels for routing */
  labels?: Record<string, string>;
  /** Transport type: "polling" or "streaming" */
  transport?: "polling" | "streaming";
  /** Logger instance (or false to disable) */
  logger?: Logger | false;
  /** Target environment (default: IRONFLOW_ENV or "default") */
  environment?: string;
  /** Event definition registry for automatic upcasting of event data */
  eventDefinitions?: EventDefinitionRegistry;
  /** API key for authentication (default: IRONFLOW_API_KEY env var) */
  apiKey?: string;
}

/**
 * Worker instance interface
 */
export interface Worker {
  /** Start the worker (blocks until stopped) */
  start(): Promise<void>;
  /** Gracefully drain and stop */
  drain(): Promise<void>;
  /** Force stop immediately */
  stop(): void;
}

// ============================================================================
// Function Definition Helpers
// ============================================================================

/**
 * Create function configuration helper
 */
export interface CreateFunctionConfig<TEvent = unknown> extends Omit<FunctionConfig<import("zod").ZodType>, 'schema'> {
  /** Schema for event validation */
  schema?: import("zod").ZodType<TEvent>;
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Context passed to the global onError handler when a client operation fails.
 */
export interface ErrorContext {
  /** Client method name (e.g. "emit", "streams.append", "apiKeys.create") */
  method: string;
  /** ConnectRPC or REST endpoint path (e.g. "/ironflow.v1.IronflowService/Trigger") */
  endpoint: string;
  /** HTTP status code (undefined for connection/timeout errors) */
  statusCode?: number;
}

/**
 * Global error handler callback type.
 * Return value is awaited; if the callback throws, the error is swallowed
 * and logged to stderr — the original error is always re-thrown.
 */
export type OnErrorHandler = (error: Error, context: ErrorContext) => void | Promise<void>;
