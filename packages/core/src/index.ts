/**
 * @ironflow/core
 *
 * Core types, schemas, and utilities shared between browser and Node.js SDKs.
 *
 * @packageDocumentation
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Branded types for type-safe IDs
  Branded,
  RunId,
  FunctionId,
  StepId,
  EventId,
  JobId,
  WorkerId,
  SubscriptionId,

  // Function types
  FunctionConfig,
  FunctionContext,
  FunctionHandler,
  IronflowFunction,
  AnyIronflowFunction,
  Trigger,
  RetryConfig,
  ConcurrencyConfig,
  DebounceConfig,
  ExecutionMode,
  PauseBehavior,

  // Paused state types (scoped injection)
  PausedStepInfo,
  PausedState,

  // Event types
  IronflowEvent,
  EventFilter,
  EventSourceType,

  // Step types
  StepClient,
  StepRunOptions,
  Duration,
  ParallelOptions,

  // Secrets types
  SecretsClient,

  // Run types
  RunInfo,
  Run,
  RunStatus,
  ListRunsOptions,
  ListRunsResult,

  // Invoke/Trigger types
  InvokeResult,
  TriggerResult, // deprecated alias for InvokeResult
  TriggerSyncOptions,
  TriggerSyncResult,

  // Emit types
  EmitOptions,
  EmitResult,
  EmitSyncResult,

  // Logger
  Logger,

  // Subscription types
  SubscribeOptions,
  BufferConfig,
  SubscriptionEvent,
  EventMetadata,
  SubscriptionErrorInfo,
  ConnectionState,
  SubscriptionCallbacks,
  Subscription,
  AckHandle,
  AckableSubscription,

  // Consumer group types
  AckMode,
  BackpressureMode,
  AckType,
  ConsumerGroupStatus,
  ConsumerGroupConfig,
  ConsumerGroup,

  // Entity stream types
  AppendEventInput,
  AppendOptions,
  AppendResult,
  ReadStreamOptions,
  StreamEvent,
  StreamInfo,
  StreamSnapshot,
  EntitySubscribeOptions,

  // Developer pub/sub types
  PublishOptions,
  PublishResult,
  TopicInfo,
  TopicStats,

  // Server types
  ServerCapabilities,

  // Time-travel debugging types
  TimeTravelStepSnapshot,
  TimeTravelRunStateSnapshot,
  TimeTravelTimelineEvent,
  TimeTravelStepOutputSnapshot,

  // Audit types
  AuditEvent,
  GetAuditTrailOptions,
  AuditTrailResult,
  AuditTrailEntry,

  // Projection management types
  RebuildJob,
  WaitResult,
  WaitProgress,

  // Time-travel client types
  TimeTravelRunState,
  TimeTravelStepOutput,

  // Webhook types
  WebhookRequest,
  WebhookEvent,
  WebhookConfig,
  IronflowWebhook,

  // Secrets management types
  Secret,
  SecretListEntry,

  // Entity stream extension types
  StreamListEntry,
  EntityHistoryEntry,

  // Project / environment types
  Project,
  Environment,

  // Event schema registry types
  EventSchema,
  RegisterSchemaInput,
  TestUpcastInput,
  UpcastResult,

  // Webhook management types
  WebhookSource,
  CreateWebhookSourceInput,
  WebhookDelivery,
  ListWebhookDeliveriesOptions,

  // User management types
  User,
  CreateUserInput,
  UpdateUserInput,

  // Tenant management types
  Tenant,
} from "./types.js";

// Branded ID factory functions and constants
export {
  createRunId,
  createFunctionId,
  createStepId,
  createEventId,
  createJobId,
  createWorkerId,
  createSubscriptionId,
  EventSource,
} from "./types.js";

// ============================================================================
// Protocol Exports
// ============================================================================

export type {
  // Push mode protocol
  PushRequest,
  PushResponse,
  CompletedStep,
  ResumeContext,
  StepResult,
  YieldInfo,
  SleepYield,
  WaitEventYield,

  // WebSocket protocol
  WSSubscribeRequest,
  WSUnsubscribeRequest,
  WSAckRequest,
  WSSubscriptionResult,
  WSEventMessage,
  WSSubscriptionError,
  WSError,
  WSServerMessage,
  WSClientMessage,

  // Retry types
  RetryEvent,
  RetryInfo,
  ClientRetryConfig,
} from "./protocol.js";

export { patterns } from "./protocol.js";

// ============================================================================
// Constants Exports
// ============================================================================

export {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_SERVER_URL,
  DEFAULT_WS_URL,
  DEFAULT_TIMEOUTS,
  DEFAULT_RETRY,
  DEFAULT_CLIENT_RETRY,
  DEFAULT_WORKER,
  DEFAULT_RECONNECT,
  ENV_VARS,
  getServerUrl,
  getWebSocketUrl,
  STEP_TYPES,
  STEP_STATUS,
  RUN_STATUS,
  WS_MESSAGE_TYPES,
  HTTP_HEADERS,
  HEADERS,
  DEFAULT_ENVIRONMENT,
  JSON_HEADERS,
  ERROR_CODES,
  API_ENDPOINTS,
  TIMING,
  ACK_TYPES,
} from "./constants.js";

// ============================================================================
// Error Exports
// ============================================================================

export {
  IronflowError,
  ConnectionError,
  SubscriptionError,
  TimeoutError,
  ValidationError,
  SchemaValidationError,
  SignatureError,
  FunctionNotFoundError,
  RunNotFoundError,
  StepError,
  NonRetryableError,
  NotConfiguredError,
  InvokeError,
  InvokeTimeoutError,
  StepTimeoutError,
  RunFailedError,
  RunCancelledError,
  AgentInvokeTimeoutError,
  NoRunCreatedError,
  MemoryCatchupTimeoutError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
  isRetryable,
  isIronflowError,
  toError,
} from "./errors.js";

// ============================================================================
// Schema Exports
// ============================================================================

export {
  // Run schemas
  RunStatusSchema,

  // Push request schemas
  CompletedStepSchema,
  ResumeContextSchema,
  PushRequestEventSchema,
  PushRequestSchema,

  // Response schemas
  TriggerResponseSchema,
  TriggerSyncResultItemSchema,
  TriggerSyncResponseSchema,
  RunResponseSchema,
  ListRunsResponseSchema,
  RegisterFunctionResponseSchema,
  HealthResponseSchema,
  ErrorResponseSchema,
  EmptyResponseSchema,

  // Time-travel debugging schemas
  TimeTravelStepSnapshotSchema,
  TimeTravelRunStateSnapshotSchema,
  TimeTravelTimelineEventSchema,

  // Audit schemas
  AuditEventSchema,

  // Consumer group schemas
  AckModeSchema,
  BackpressureModeSchema,
  ConsumerGroupStatusSchema,
  ConsumerGroupResponseSchema,
  ListConsumerGroupsResponseSchema,

  // Worker schemas
  JobCompletedStepSchema,
  JobEventSchema,
  JobContextSchema,
  JobAssignmentSchema,

  // WebSocket schemas
  EventMetadataSchema,
  WSSubscriptionResultItemSchema,
  WSSubscriptionResultSchema,
  WSEventMessageSchema,
  WSSubscriptionErrorSchema,
  WSErrorSchema,
  WSServerMessageSchema,

  // Inferred types
  type ValidatedPushRequest,
  type ValidatedRunResponse,
  type ValidatedJobAssignment,
  type ValidatedWSServerMessage,

  // Validation helpers
  parseAndValidate,
  validate,
} from "./schemas.js";

// ============================================================================
// Logger Exports
// ============================================================================

export {
  createLogger,
  createNoopLogger,
  type LogLevel,
  type LoggerConfig,
} from "./logger.js";

// ============================================================================
// Utility Exports
// ============================================================================

export {
  parseDuration,
  calculateBackoff,
  sleep,
  createDeferred,
  generateId,
  safeJsonParse,
  isObject,
  deepMerge,
  type Deferred,
} from "./utils.js";

// ============================================================================
// Upcaster Exports
// ============================================================================

export { createUpcasterRegistry, type UpcasterFn } from "./upcaster.js";
export { defineEvent, createEventDefinitionRegistry, type EventDefinition, type EventDefinitionOptions, type EventDefinitionRegistry } from "./event-definition.js";

// ============================================================================
// Projection Exports
// ============================================================================

export type {
  ProjectionMode,
  ProjectionStatus,
  ProjectionContext,
  ManagedProjectionHandler,
  ExternalProjectionHandler,
  ProjectionConfig,
  IronflowProjection,
  ProjectionStatusInfo,
  ProjectionStateResult,
  GetProjectionOptions,
  RebuildProjectionOptions,
  ProjectionSubscriptionCallbacks,
  CreateSQLProjectionInput,
  QuerySQLProjectionOptions,
  SQLProjectionQueryResult,
} from "./projection-types.js";

export { peelProjectionEnvelope } from "./projection-types.js";

// ============================================================================
// KV Exports
// ============================================================================

export type {
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
} from "./kv-types.js";

// ============================================================================
// Config Exports
// ============================================================================

export type {
  ConfigResponse,
  ConfigEntry,
  ConfigSetResult,
  ConfigWatchEvent,
  ConfigWatchCallbacks,
  ConfigWatcher,
} from "./config-types.js";

// ============================================================================
// Auth Types
// ============================================================================

export type {
  APIKey,
  APIKeyWithSecret,
  CreateAPIKeyInput,
  Organization,
  CreateOrgInput,
  UpdateOrgInput,
  Role,
  CreateRoleInput,
  UpdateRoleInput,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
} from "./auth-types.js";

// ============================================================================
// Generated Protobuf/ConnectRPC Exports
// ============================================================================
// NOTE: Protobuf and ConnectRPC generated code is NOT exported from the main
// entry point to avoid loading heavy dependencies for users who only need
// the HTTP client. Import from "@ironflow/core/gen" if you need them.
