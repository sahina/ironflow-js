/**
 * Connect RPCs that change nothing on the server: the methods the protos mark
 * `idempotency_level = NO_SIDE_EFFECTS`. The client may send these again
 * after a failure that could have reached the handler.
 *
 * A static list, not a read of the generated descriptors at runtime: loading
 * every descriptor roughly doubles the import time of `@ironflow/node`.
 * safe-rpc-paths.test.ts fails when this list and the protos disagree.
 *
 * Grouped by service, not written as full paths: scripts/sdkcoverage counts
 * every full RPC path literal in this package as an endpoint the client wraps.
 */
const SAFE_METHODS: Record<string, string[]> = {
  "ironflow.v1.AgentToolsService": [
    "ListTools",
  ],
  "ironflow.v1.AuditService": [
    "GetAuditTrail",
    "GetAuthAuditTrail",
  ],
  "ironflow.v1.DeploymentService": [
    "GetDeployment",
    "GetFunctionExecutionRouting",
    "ListDeployments",
  ],
  "ironflow.v1.EntityStreamService": [
    "GetEntityHistory",
    "GetSnapshot",
    "GetStreamInfo",
    "ListStreams",
    "ReadStream",
  ],
  "ironflow.v1.EventSchemaService": [
    "CheckEnforcement",
    "GetSchema",
    "ListSchemas",
    "TestUpcast",
  ],
  "ironflow.v1.IronflowService": [
    "GetFunction",
    "GetFunctionAtVersion",
    "GetPausedState",
    "GetRun",
    "GetRunSteps",
    "ListFunctionHistory",
    "ListFunctions",
    "ListRuns",
  ],
  "ironflow.v1.ProjectionService": [
    "GetProjection",
    "GetProjectionStatus",
    "GetRebuildJob",
    "ListProjections",
    "QuerySQLProjection",
  ],
  "ironflow.v1.PubSubService": [
    "GetConsumerGroup",
    "GetTopicStats",
    "ListConsumerGroups",
    "ListTopics",
  ],
  "ironflow.v1.QueryService": [
    "ExecuteSQL",
  ],
  "ironflow.v1.TimeTravelService": [
    "GetRunStateAt",
    "GetRunTimeline",
    "GetStepOutputAt",
  ],
  "ironflow.v1.WebhookService": [
    "GetWebhookSource",
    "ListWebhookDeliveries",
    "ListWebhookSources",
  ],
};

export const SAFE_RPC_PATHS: ReadonlySet<string> = new Set(
  Object.entries(SAFE_METHODS).flatMap(([service, methods]) => methods.map((method) => `/${service}/${method}`))
);
