/**
 * @ironflow/node
 *
 * Node.js SDK for Ironflow, an event-driven backend platform.
 * Provides workers, serve handlers, and step execution for serverless and long-running functions.
 *
 * @example
 * ```typescript
 * // Define a workflow function
 * import { ironflow } from "@ironflow/node";
 *
 * const processOrder = ironflow.createFunction(
 *   {
 *     id: "process-order",
 *     triggers: [{ event: "order.placed" }],
 *   },
 *   async ({ event, step }) => {
 *     const result = await step.run("process", async () => {
 *       return { processed: true };
 *     });
 *     return result;
 *   }
 * );
 *
 * // Push mode (serverless)
 * import { serve } from "@ironflow/node/serve";
 * export const POST = serve({ functions: [processOrder] });
 *
 * // Pull mode (worker)
 * import { createWorker } from "@ironflow/node/worker";
 * const worker = createWorker({
 *   serverUrl: "http://localhost:9123",
 *   functions: [processOrder],
 * });
 * await worker.start();
 * ```
 *
 * @packageDocumentation
 */

// Main exports
import { ironflow } from "./function.js";
export { ironflow, createFunction } from "./function.js";
export { serve, createHandler } from "./serve.js";
export { createWorker } from "./worker.js";
export { createProjection } from "./projection.js";
export { createProjectionRunner, ProjectionRunner, StreamingUnsupportedError, type ProjectionRunnerConfig } from "./projection-runner.js";
// NOTE: createStreamingWorker is NOT exported here to avoid loading protobuf
// dependencies. Import from "@ironflow/node/worker-streaming" if you need it.
export { createWebhook } from "./webhook.js";
export { createSecretsClient } from "./secrets.js";
export { createClient, IronflowClient } from "./client.js";
export {
  createSubscriptionClient,
  SubscriptionClient,
  type SubscriptionClientConfig,
} from "./subscribe.js";
export type {
  IronflowClientConfig,
  RegisterFunctionRequest,
  RegisterFunctionResult,
} from "./client.js";
export { KVClient, KVBucketHandle } from "./kv.js";
export type { KVClientConfig } from "./kv.js";
export { CommandDedup, DEFAULT_COMMAND_DEDUP_TTL_SECONDS } from "./command-dedup.js";
export type { CommandDedupOptions } from "./command-dedup.js";
export { ConfigClient } from "./config-client.js";
export type { ConfigClientConfig, ConfigWatchEvent, ConfigWatchCallbacks, ConfigWatcher } from "./config-client.js";

// Type exports
export type {
  ServeConfig,
  HandlerOptions,
  HandlerContext,
  WorkerConfig,
  Worker,
  CreateFunctionConfig,
  ErrorContext,
  OnErrorHandler,
} from "./types.js";

// Re-export all types from core
export type {
  // Branded types
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
  Trigger,
  RetryConfig,
  ConcurrencyConfig,
  ExecutionMode,

  // Event types
  IronflowEvent,
  EventFilter,

  // Step types
  StepClient,
  Duration,
  ParallelOptions,

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

  // Entity stream types
  AppendEventInput,
  AppendOptions,
  AppendResult,
  ReadStreamOptions,
  StreamEvent,
  StreamInfo,

  // Secrets
  SecretsClient,

  // Logger
  Logger,

  // Push/Pull protocol
  PushRequest,
  PushResponse,
  CompletedStep,
  ResumeContext,
  StepResult,
  YieldInfo,
  SleepYield,
  WaitEventYield,

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
  // Subscription types
  SubscribeOptions,
  SubscriptionEvent,
  SubscriptionErrorInfo,
  Subscription,
  AckableSubscription,
  ConnectionState,

  // Webhook types
  WebhookConfig,
  WebhookRequest,
  WebhookEvent,
  IronflowWebhook,

  // Projection types
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

  // Auth types
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
} from "@ironflow/core";

// Re-export branded ID creators
export {
  createRunId,
  createFunctionId,
  createStepId,
  createEventId,
  createJobId,
  createWorkerId,
  createSubscriptionId,
} from "@ironflow/core";

// Re-export errors
export {
  IronflowError,
  StepError,
  TimeoutError,
  ValidationError,
  SchemaValidationError,
  SignatureError,
  FunctionNotFoundError,
  RunNotFoundError,
  NonRetryableError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
  isRetryable,
  isIronflowError,
} from "@ironflow/core";

// Re-export utilities
export {
  parseDuration,
  calculateBackoff,
  sleep,
  generateId,
  createLogger,
  createNoopLogger,
  type LogLevel,
  type LoggerConfig,
} from "@ironflow/core";

// Re-export constants
export {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_SERVER_URL,
  DEFAULT_TIMEOUTS,
  DEFAULT_RETRY,
  DEFAULT_WORKER,
  ENV_VARS,
  getServerUrl,
  patterns,
} from "@ironflow/core";

// Re-export schemas for advanced usage
export {
  PushRequestSchema,
  RunStatusSchema,
  parseAndValidate,
  validate,
} from "@ironflow/core";

// Run context — advanced usage
export { withRunContext, getCurrentRunId } from "./internal/run-context.js";

// Default export
export default { ironflow };
