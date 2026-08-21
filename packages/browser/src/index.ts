/**
 * @ironflow/browser
 *
 * Browser client for Ironflow, an event-driven backend platform.
 * Provides real-time subscriptions, workflow triggers, and event emission.
 *
 * @example
 * ```typescript
 * import { ironflow } from '@ironflow/browser';
 *
 * // Configure once at app startup
 * ironflow.configure({
 *   serverUrl: 'https://ironflow.example.com',
 * });
 *
 * // Connect and subscribe
 * await ironflow.connect();
 *
 * const sub = ironflow.subscribe('events:order.*', {
 *   onEvent: (event) => console.log(event),
 *   onError: (error) => console.error(error),
 * });
 *
 * // Invoke workflow functions
 * const run = await ironflow.invoke('process-order', {
 *   data: { orderId: '123' }
 * });
 *
 * // Emit events
 * await ironflow.emit('order.approved', { orderId: '123' });
 *
 * // Cleanup
 * sub.unsubscribe();
 * ironflow.disconnect();
 * ```
 *
 * @packageDocumentation
 */

// Main client export
export { ironflow } from "./client.js";
// The type, so an app can annotate `OfflineClient.client` or mock it. The class
// itself stays unexported — construction goes through `ironflow` or
// `createClient()`.
export type { IronflowClient } from "./client.js";

// Configuration types
export type {
  IronflowConfig,
  IronflowConfigOptions,
  ReconnectConfig,
  VisibilityConfig,
  AuthConfig,
} from "./config.js";
export { DEFAULT_CONFIG, mergeConfig } from "./config.js";

// Subscription types
export type {
  BrowserSubscribeOptions,
  SubscriptionGroup,
} from "./subscription.js";

// Transport types (for advanced usage)
export type {
  Transport,
  TransportCallbacks,
  TransportFactory,
  TransportOptions,
} from "./transport/index.js";
export { createWebSocketTransport, createConnectRPCTransport } from "./transport/index.js";

// KV exports
export { BrowserKVClient, BrowserKVBucketHandle } from "./kv.js";

// Config exports
export { BrowserConfigClient } from "./config-client.js";

// Subscription manager (for typing singleton/cached references)
export { SubscriptionManager } from "./subscription.js";

// Agents namespace types
export type {
  AgentsNamespace,
  AgentInvokeOptions,
  AgentInvokeResult,
  AgentProgressEvent,
  AgentStepEvent,
  AgentSubscribeCallbacks,
} from "./agents/index.js";

// Re-export commonly used types from core
export type {
  // Run types
  Run,
  RunStatus,
  RunInfo,
  ListRunsOptions,
  ListRunsResult,

  // Event types
  IronflowEvent,
  EmitOptions,
  EmitResult,

  // Invoke/Trigger types
  InvokeResult,
  TriggerResult, // deprecated alias for InvokeResult
  TriggerSyncOptions,
  TriggerSyncResult,

  // Subscription types
  SubscribeOptions,
  Subscription,
  AckableSubscription,
  SubscriptionEvent,
  SubscriptionErrorInfo,
  SubscriptionCallbacks,
  ConnectionState,
  AckHandle,

  // Consumer group types
  ConsumerGroup,
  ConsumerGroupConfig,
  ConsumerGroupStatus,
  AckMode,
  BackpressureMode,

  // Entity stream types
  AppendEventInput,
  AppendOptions,
  AppendResult,
  ReadStreamOptions,
  StreamEvent,
  StreamInfo,
  EntitySubscribeOptions,

  // Projection types
  ProjectionStatusInfo,
  ProjectionStateResult,

  // KV types
  KVBucketConfig,
  KVBucketInfo,
  KVEntry,
  KVPutResult,
  KVListKeysResult,
  KVListBucketsResult,
  KVWatchEvent,
  KVWatchCallbacks,
  KVWatchOptions,
  KVWatcher,

  // Config types
  ConfigResponse,
  ConfigEntry,
  ConfigSetResult,
  ConfigWatchCallbacks,
  ConfigWatchEvent,

  // Audit types
  AuditEvent,
  AuditTrailResult,
  GetAuditTrailOptions,

  // Webhook management types
  WebhookSource,
  CreateWebhookSourceInput,
  UpdateWebhookSourceInput,
  RotateWebhookSecretInput,
  DisableWebhookSignatureVerificationInput,
  WebhookDelivery,
  ListWebhookDeliveriesOptions,

  // User management types
  User,
  CreateUserInput,
  UpdateUserInput,

  // Tenant management types
  Tenant,

  // Logger
  Logger,
} from "@ironflow/core";

// Re-export utilities
export {
  patterns,
  DEFAULT_SERVER_URL,
  DEFAULT_WS_URL,
  DEFAULT_TIMEOUTS,
  getServerUrl,
  getWebSocketUrl,
} from "@ironflow/core";

// Re-export error types
export {
  IronflowError,
  ConnectionError,
  SubscriptionError,
  TimeoutError,
  ValidationError,
  NotConfiguredError,
  RunFailedError,
  RunCancelledError,
  AgentInvokeTimeoutError,
  NoRunCreatedError,
  isRetryable,
  isIronflowError,
} from "@ironflow/core";

// ============================================================================
// Offline write queue (ADR 0053)
// ============================================================================

// Opt-in via a factory rather than a flag on the `ironflow` singleton:
// configure() returns void, so a runtime option cannot refine emit()'s static
// return type, and widening it on the singleton would break every caller who
// never asked for queueing.
export {
  createClient,
  OfflineClient,
  queueDbName,
  type CreateClientOptions,
  type OfflineQueueConfig,
  type QueueApi,
  type QueuedWriteResult,
} from "./offline.js";

export {
  type DeadLetteredWrite,
  type QueuedWrite,
  type QueuedWriteKind,
  type QueueState,
  type QueueStats,
  type WriteLostReason,
  type WriteStatus,
} from "./queue/types.js";

export { QueueFullError } from "@ironflow/core";
