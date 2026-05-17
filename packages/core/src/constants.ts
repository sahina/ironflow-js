/**
 * Default configuration constants for Ironflow SDK.
 */

/** Default HTTP server port for Ironflow. */
export const DEFAULT_PORT = 9123;

/** Default host for Ironflow. */
export const DEFAULT_HOST = "localhost";

/** Default server URL for Ironflow. */
export const DEFAULT_SERVER_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

/** Default WebSocket URL for Ironflow. */
export const DEFAULT_WS_URL = `ws://${DEFAULT_HOST}:${DEFAULT_PORT}/ws`;

/** Environment variable names */
export const ENV_VARS = {
  /** Environment variable for server URL. */
  SERVER_URL: "IRONFLOW_SERVER_URL",
  /** Environment variable for signing key. */
  SIGNING_KEY: "IRONFLOW_SIGNING_KEY",
  /** Environment variable for API key. */
  API_KEY: "IRONFLOW_API_KEY",
  /** Environment variable for log level (debug, info, warn, error, silent). */
  LOG_LEVEL: "IRONFLOW_LOG_LEVEL",
} as const;

/** Default timeout values in milliseconds */
export const DEFAULT_TIMEOUTS = {
  /** Default client timeout (30 seconds). */
  CLIENT: 30_000,
  /** Default function timeout (10 minutes). */
  FUNCTION: 600_000,
  /** Default trigger sync timeout (30 seconds). */
  TRIGGER_SYNC: 30_000,
} as const;

/** Default retry configuration for function steps */
export const DEFAULT_RETRY = {
  /** Default maximum retry attempts. */
  MAX_ATTEMPTS: 3,
  /** Default initial delay in milliseconds. */
  INITIAL_DELAY_MS: 1000,
  /** Default backoff factor. */
  BACKOFF_FACTOR: 2.0,
  /** Default maximum delay in milliseconds (5 minutes). */
  MAX_DELAY_MS: 300_000,
} as const;

/** Default client retry configuration for HTTP requests */
export const DEFAULT_CLIENT_RETRY = {
  /** Default maximum retry attempts. */
  MAX_ATTEMPTS: 3,
  /** Default initial delay in milliseconds for server errors. */
  INITIAL_DELAY_MS: 100,
  /** Default backoff factor for server errors. */
  BACKOFF_MULTIPLIER: 2.0,
  /** Default maximum delay in milliseconds (10 seconds). */
  MAX_DELAY_MS: 10_000,
  /** Default fixed delay for connection errors in milliseconds (2 seconds). */
  CONNECTION_RETRY_DELAY_MS: 2_000,
} as const;

/** Default worker configuration */
export const DEFAULT_WORKER = {
  /** Default maximum concurrent jobs. */
  MAX_CONCURRENT_JOBS: 10,
  /** Default heartbeat interval in milliseconds (30 seconds). */
  HEARTBEAT_INTERVAL_MS: 30_000,
  /** Default reconnect delay in milliseconds (5 seconds). */
  RECONNECT_DELAY_MS: 5_000,
} as const;

/** Default reconnection configuration */
export const DEFAULT_RECONNECT = {
  /** Whether auto-reconnect is enabled by default. */
  ENABLED: true,
  /** Maximum reconnection attempts (-1 for infinite). */
  MAX_ATTEMPTS: 10,
  /** Initial backoff delay in milliseconds. */
  INITIAL_DELAY_MS: 1_000,
  /** Maximum backoff delay in milliseconds. */
  MAX_DELAY_MS: 30_000,
  /** Backoff multiplier. */
  MULTIPLIER: 2,
} as const;

/**
 * Get the server URL from environment variable or return the default.
 * Works in both Node.js and browser environments.
 */
export function getServerUrl(): string {
  if (typeof process !== "undefined" && process.env?.[ENV_VARS.SERVER_URL]) {
    return process.env[ENV_VARS.SERVER_URL]!;
  }
  return DEFAULT_SERVER_URL;
}

/**
 * Get the WebSocket URL from environment variable or return the default.
 * Converts HTTP URLs to WebSocket URLs.
 */
export function getWebSocketUrl(serverUrl?: string): string {
  const url = serverUrl || getServerUrl();
  if (url.startsWith("https://")) {
    return url.replace("https://", "wss://") + "/ws";
  }
  if (url.startsWith("http://")) {
    return url.replace("http://", "ws://") + "/ws";
  }
  return url + "/ws";
}

/** Step types for workflow execution */
export const STEP_TYPES = {
  /** Invoke a sub-function or external call */
  INVOKE: "invoke",
  /** Sleep/pause execution for a duration */
  SLEEP: "sleep",
  /** Wait for an external event */
  WAIT_FOR_EVENT: "wait_for_event",
} as const;

/** Step status values */
export const STEP_STATUS = {
  /** Step completed successfully */
  COMPLETED: "completed",
  /** Step failed with an error */
  FAILED: "failed",
  /** Step is waiting (for sleep or event) */
  WAITING: "waiting",
} as const;

/** Run status values */
export const RUN_STATUS = {
  /** Run is pending execution */
  PENDING: "pending",
  /** Run is currently executing */
  RUNNING: "running",
  /** Run completed successfully */
  COMPLETED: "completed",
  /** Run failed with an error */
  FAILED: "failed",
  /** Run was cancelled */
  CANCELLED: "cancelled",
  /** Run is paused (waiting for event or sleep) */
  PAUSED: "paused",
} as const;

/** WebSocket message types for pub/sub */
export const WS_MESSAGE_TYPES = {
  /** Subscribe to a pattern */
  SUBSCRIBE: "subscribe",
  /** Unsubscribe from a pattern */
  UNSUBSCRIBE: "unsubscribe",
  /** Acknowledge message receipt */
  ACK: "ack",
  /** Event message from server */
  EVENT: "event",
  /** Subscription result/confirmation */
  SUBSCRIPTION_RESULT: "subscription_result",
  /** Subscription error */
  SUBSCRIPTION_ERROR: "subscription_error",
  /** General error */
  ERROR: "error",
} as const;

/** HTTP headers */
export const HTTP_HEADERS = {
  /** Content-Type for JSON */
  CONTENT_TYPE_JSON: "application/json",
} as const;

/** Ironflow-specific headers */
export const HEADERS = {
  /** Header for environment isolation */
  ENVIRONMENT: "X-Ironflow-Environment",
} as const;

/** Default environment name */
export const DEFAULT_ENVIRONMENT = "default";

/** JSON headers for fetch requests */
export const JSON_HEADERS = {
  "Content-Type": HTTP_HEADERS.CONTENT_TYPE_JSON,
} as const;

/** Error codes returned by the SDK */
export const ERROR_CODES = {
  /** Function not found in registry */
  FUNCTION_NOT_FOUND: "FUNCTION_NOT_FOUND",
  /** Validation error in request */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** Invalid webhook signature */
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  /** Network/connection error */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** Server error (5xx) */
  SERVER_ERROR: "SERVER_ERROR",
  /** Timeout error */
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  /** Connection lost */
  CONNECTION_LOST: "CONNECTION_LOST",
  /** Connection refused */
  CONNECTION_REFUSED: "CONNECTION_REFUSED",
  /** Subscription error */
  SUBSCRIPTION_ERROR: "SUBSCRIPTION_ERROR",
  /** Not configured */
  NOT_CONFIGURED: "NOT_CONFIGURED",
} as const;

/** ConnectRPC API endpoints */
export const API_ENDPOINTS = {
  /** Trigger a function */
  TRIGGER: "/ironflow.v1.IronflowService/Trigger",
  /** Trigger a function synchronously */
  TRIGGER_SYNC: "/ironflow.v1.IronflowService/TriggerSync",
  /** Get a specific run */
  GET_RUN: "/ironflow.v1.IronflowService/GetRun",
  /** List runs */
  LIST_RUNS: "/ironflow.v1.IronflowService/ListRuns",
  /** Cancel a run */
  CANCEL_RUN: "/ironflow.v1.IronflowService/CancelRun",
  /** Retry a run */
  RETRY_RUN: "/ironflow.v1.IronflowService/RetryRun",
  /** Register a function */
  REGISTER_FUNCTION: "/ironflow.v1.IronflowService/RegisterFunction",
  /** Health check */
  HEALTH: "/ironflow.v1.IronflowService/Health",
  /** Emit an event */
  EMIT: "/ironflow.v1.PubSubService/Emit",
  /** Create a consumer group */
  CREATE_CONSUMER_GROUP: "/ironflow.v1.PubSubService/CreateConsumerGroup",
  /** Get a consumer group */
  GET_CONSUMER_GROUP: "/ironflow.v1.PubSubService/GetConsumerGroup",
  /** List consumer groups */
  LIST_CONSUMER_GROUPS: "/ironflow.v1.PubSubService/ListConsumerGroups",
  /** Delete a consumer group */
  DELETE_CONSUMER_GROUP: "/ironflow.v1.PubSubService/DeleteConsumerGroup",
} as const;

/** Timing constants */
export const TIMING = {
  /** Default poll interval in milliseconds */
  POLL_INTERVAL_MS: 1000,
  /** Error retry delay in milliseconds */
  ERROR_RETRY_DELAY_MS: 5000,
  /** Default reconnect delay in milliseconds */
  RECONNECT_DELAY_MS: 1000,
  /** WebSocket normal close code */
  WS_CLOSE_NORMAL: 1000,
} as const;

/** Ack types for message acknowledgment */
export const ACK_TYPES = {
  /** Positive acknowledgment */
  ACK: "ack",
  /** Negative acknowledgment (retry) */
  NAK: "nak",
  /** Terminal acknowledgment (no retry) */
  TERM: "term",
} as const;
