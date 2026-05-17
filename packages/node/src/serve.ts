/**
 * Universal HTTP Serve Handler
 *
 * Provides a universal handler that works with:
 * - Next.js App Router (export const POST = serve(...))
 * - Express (app.post("/api/ironflow", serve(...)))
 * - Hono (app.post("/api/ironflow", serve(...)))
 * - Generic Fetch API (native Request/Response)
 */

import type {
  IronflowFunction,
  IronflowWebhook,
  Logger,
  FunctionContext,
  PushResponse,
  EventDefinitionRegistry,
} from "@ironflow/core";
import {
  IronflowError,
  FunctionNotFoundError,
  isRetryable,
  PushRequestSchema,
  createLogger,
  createNoopLogger,
  HEADERS,
  DEFAULT_ENVIRONMENT,
  type ValidatedPushRequest,
} from "@ironflow/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServeConfig } from "./types.js";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient, executeCompensations } from "./step.js";
import { isYieldSignal } from "./internal/errors.js";
import { createSecretsClient } from "./secrets.js";
import { withRunContext } from "./internal/run-context.js";
import { DISPATCH_PATH, handleAgentToolDispatch } from "./agent/dispatch.js";

/**
 * Node.js IncomingMessage-like object
 * @internal
 */
interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on?(event: string, callback: (data: unknown) => void): void;
  body?: string | Buffer | unknown;
}

/**
 * Node.js ServerResponse-like object
 * @internal
 */
interface NodeResponse {
  statusCode?: number;
  setHeader?(name: string, value: string): void;
  end?(data: string): void;
  writeHead?(statusCode: number, headers: Record<string, string>): void;
}

/**
 * Universal handler function signature
 */
type UniversalHandler = (
  request: Request | NodeRequest,
  responseOrContext?: NodeResponse | unknown
) => Promise<Response | void>;

/**
 * Create a universal HTTP handler for Ironflow functions
 *
 * @example
 * ```typescript
 * // Next.js App Router
 * import { serve } from "@ironflow/node/serve";
 * import { processOrder } from "./functions/process-order";
 *
 * export const POST = serve({
 *   functions: [processOrder],
 *   signingKey: process.env.IRONFLOW_SIGNING_KEY,
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Express
 * import { serve } from "@ironflow/node/serve";
 *
 * app.post("/api/ironflow", serve({
 *   functions: [processOrder],
 *   signingKey: process.env.IRONFLOW_SIGNING_KEY,
 * }));
 * ```
 */
export function serve(config: ServeConfig): UniversalHandler {
  // Resolve environment
  const environment =
    config.environment ?? process.env.IRONFLOW_ENV ?? DEFAULT_ENVIRONMENT;

  // Initialize logger
  let logger: Logger;
  if (config.logger === false) {
    logger = createNoopLogger();
  } else if (config.logger) {
    logger = config.logger;
  } else {
    logger = createLogger({ prefix: "[ironflow-serve]" });
  }

  // Build function map for fast lookup
  const functionMap = new Map<string, IronflowFunction>();
  for (const fn of config.functions) {
    if (functionMap.has(fn.config.id)) {
      logger.warn(
        `Duplicate function ID "${fn.config.id}" — the later definition will overwrite the earlier one. ` +
        "Each function should have a unique ID."
      );
    }
    functionMap.set(fn.config.id, fn);
  }

  // Build webhook map for fast lookup
  const webhookMap = new Map<string, IronflowWebhook>();
  if (config.webhooks) {
    for (const wh of config.webhooks) {
      webhookMap.set(wh.config.id, wh);
    }
  }

  // Warn about projections in push mode
  if (config.projections?.length) {
    logger.warn(
      "Projections in push mode are not supported. " +
      "Use createWorker() for projections."
    );
  }

  // Warn about missing signature verification
  if (!config.signingKey && !config.skipVerification) {
    logger.warn(
      "No signingKey configured — webhook requests will not be authenticated. " +
      "Set signingKey in serve config for production use."
    );
  }

  // The universal handler
  const handler: UniversalHandler = async (
    requestOrReq: Request | NodeRequest,
    resOrContext?: NodeResponse | unknown
  ): Promise<Response | void> => {
    // Detect environment and normalize request
    const { request, sendResponse } = normalizeRequest(
      requestOrReq,
      resOrContext,
      environment
    );

    try {
      // Check if this is an agent-tool dispatch from `ironflow serve` →
      // `exposeMcp()` callback. Discriminated by URL suffix so it works
      // alongside the existing /webhooks routes and the bare push path.
      const reqPath = extractRequestPath(requestOrReq);
      if (reqPath.endsWith(DISPATCH_PATH)) {
        const result = await handleAgentToolDispatch(request);
        return sendResponse(result.status, result.body);
      }

      // Check if this is a webhook request
      let webhookProvider: string | undefined;
      if (requestOrReq instanceof Request) {
        const url = new URL(requestOrReq.url, "http://localhost");
        const webhookMatch = url.pathname.match(/\/webhooks\/([^/]+)/);
        if (webhookMatch) {
          webhookProvider = webhookMatch[1];
        }
      } else {
        // Node.js request
        const nodeReq = requestOrReq as NodeRequest;
        const webhookMatch = (nodeReq.url || "").match(/\/webhooks\/([^/]+)/);
        if (webhookMatch) {
          webhookProvider = webhookMatch[1];
        }
      }

      if (webhookProvider && webhookMap.size > 0) {
        const wh = webhookMap.get(webhookProvider);
        if (!wh) {
          return sendResponse(404, {
            error: { message: `Webhook source not found: ${webhookProvider}`, code: "WEBHOOK_NOT_FOUND" },
          });
        }

        const body = await request.text();
        const headers: Record<string, string> = {};
        // Extract headers from the original request
        if (requestOrReq instanceof Request) {
          requestOrReq.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } else {
          const nodeReq = requestOrReq as NodeRequest;
          for (const [key, value] of Object.entries(nodeReq.headers)) {
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value[0] ?? "";
          }
        }

        try {
          await wh.config.verify({ body, headers });
        } catch (err) {
          return sendResponse(401, {
            error: {
              message: err instanceof Error ? err.message : "Verification failed",
              code: "VERIFY_FAILED",
            },
          });
        }

        try {
          const payload = JSON.parse(body);
          const event = await wh.config.transform(payload);

          // Emit event to Ironflow server if configured
          const emitUrl = config.serverUrl || process.env.IRONFLOW_URL;
          if (emitUrl) {
            const emitBody: Record<string, unknown> = {
              name: event.name,
              data: event.data,
            };
            if (event.idempotencyKey) {
              emitBody.idempotencyKey = event.idempotencyKey;
            }
            const emitResp = await fetch(`${emitUrl}/api/v1/events`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(emitBody),
            });
            if (!emitResp.ok) {
              const errText = await emitResp.text();
              return sendResponse(502, {
                error: { message: `Failed to emit event: ${errText}`, code: "EMIT_FAILED" },
              });
            }
          }

          return sendResponse(200, { status: "accepted", event });
        } catch (err) {
          return sendResponse(400, {
            error: {
              message: err instanceof Error ? err.message : "Transform failed",
              code: "TRANSFORM_FAILED",
            },
          });
        }
      }

      // Read body
      const body = await request.text();

      // Verify signature (unless skipped for dev)
      if (config.signingKey && !config.skipVerification) {
        const signature = request.headers.get("x-ironflow-signature");
        if (!signature) {
          return sendResponse(401, {
            error: { message: "Missing signature", code: "SIGNATURE_MISSING" },
          });
        }

        if (!verifySignature(body, signature, config.signingKey)) {
          return sendResponse(401, {
            error: { message: "Invalid signature", code: "SIGNATURE_INVALID" },
          });
        }
      }

      // Parse and validate request
      let pushRequest: ValidatedPushRequest;
      try {
        const parsed: unknown = JSON.parse(body);
        const result = PushRequestSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", ");
          return sendResponse(400, {
            error: {
              message: `Invalid request body: ${issues}`,
              code: "VALIDATION_ERROR",
            },
          });
        }
        pushRequest = result.data;
      } catch {
        return sendResponse(400, {
          error: { message: "Invalid JSON body", code: "INVALID_JSON" },
        });
      }

      // Find function
      const fn = functionMap.get(pushRequest.function_id);
      if (!fn) {
        return sendResponse(404, {
          error: {
            message: `Function not found: ${pushRequest.function_id}`,
            code: "FUNCTION_NOT_FOUND",
          },
        });
      }

      // Execute function
      const serverUrl = config.serverUrl || process.env.IRONFLOW_URL || process.env.IRONFLOW_SERVER_URL;
      const response = await executeHandler(fn, pushRequest, config.eventDefinitions, serverUrl);
      return sendResponse(200, response);
    } catch (error) {
      // Unexpected error
      logger.error("Unexpected error in serve handler", {
        error: error instanceof Error ? error.message : String(error),
      });
      return sendResponse(500, {
        error: {
          message: error instanceof Error ? error.message : "Internal server error",
          code: "INTERNAL_ERROR",
        },
      });
    }
  };

  return handler;
}

/**
 * Execute a function handler and build the response
 */
async function executeHandler(
  fn: IronflowFunction,
  request: ValidatedPushRequest,
  eventDefinitions?: EventDefinitionRegistry,
  serverUrl?: string
): Promise<PushResponse> {
  // Create execution context (with optional upcasting)
  const ctx = new ExecutionContext(request, undefined, eventDefinitions, fn.config.stepTimeout, serverUrl);

  // Create step client
  const step = createStepClient(ctx);

  // Build function context
  const functionContext: FunctionContext = {
    event: ctx.event,
    step,
    run: ctx.runInfo,
    logger: ctx.logger,
    secrets: createSecretsClient(request.secrets),
  };

  try {
    // Execute the function handler
    const result = await withRunContext(ctx.runId, () =>
      fn.handler(functionContext)
    );

    // Function completed successfully
    return {
      status: "completed",
      steps: ctx.getExecutedSteps(),
      result,
    };
  } catch (error) {
    // Check if this is a yield signal (sleep/waitForEvent)
    if (isYieldSignal(error)) {
      return {
        status: "yielded",
        steps: ctx.getExecutedSteps(),
        yield: error.yieldInfo,
      };
    }

    // Handle actual errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorCode = error instanceof IronflowError ? error.code : "ERROR";
    const retryable = isRetryable(error);

    // Run compensations only if error is not retryable (terminal failure)
    if (ctx.hasCompensations() && !retryable) {
      await executeCompensations(ctx);
    }

    // Get step ID if it's a step error
    let stepId: string | undefined;
    if (error instanceof FunctionNotFoundError) {
      stepId = undefined;
    } else if (error instanceof IronflowError && error.details?.["stepId"]) {
      stepId = error.details["stepId"] as string;
    }

    ctx.logger.error(`Function failed: ${errorMessage}`, {
      code: errorCode,
      retryable,
      stepId,
    });

    return {
      status: "failed",
      steps: ctx.getExecutedSteps(),
      error: {
        message: errorMessage,
        code: errorCode,
        step_id: stepId,
        retryable,
        stack: errorStack,
      },
    };
  }
}

/**
 * Normalized request interface
 */
interface NormalizedRequest {
  request: {
    text(): Promise<string>;
    headers: {
      get(name: string): string | null;
    };
  };
  sendResponse: (status: number, body: unknown) => Response | void;
}

/**
 * Normalize different request types into a common interface
 */
function normalizeRequest(
  request: Request | NodeRequest,
  responseOrContext?: NodeResponse | unknown,
  environment?: string
): NormalizedRequest {
  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (environment) {
    responseHeaders[HEADERS.ENVIRONMENT] = environment;
  }

  // Check if it's a native Fetch Request
  if (request instanceof Request) {
    return {
      request: {
        text: () => request.text(),
        headers: {
          get: (name: string) => request.headers.get(name),
        },
      },
      sendResponse: (status: number, body: unknown) => {
        return new Response(JSON.stringify(body), {
          status,
          headers: responseHeaders,
        });
      },
    };
  }

  // It's a Node.js-style request
  const nodeReq = request as NodeRequest;
  const nodeRes = responseOrContext as NodeResponse | undefined;

  return {
    request: {
      text: async () => {
        // If body is already parsed (e.g., by express.json())
        if (typeof nodeReq.body === "string") {
          return nodeReq.body;
        }
        if (Buffer.isBuffer(nodeReq.body)) {
          return nodeReq.body.toString("utf-8");
        }
        if (typeof nodeReq.body === "object" && nodeReq.body !== null) {
          return JSON.stringify(nodeReq.body);
        }

        // Read from stream
        return new Promise<string>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          nodeReq.on?.("data", (chunk: unknown) => {
            if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
              chunks.push(chunk);
            } else if (typeof chunk === "string") {
              chunks.push(Buffer.from(chunk));
            }
          });
          nodeReq.on?.("end", () =>
            resolve(Buffer.concat(chunks).toString("utf-8"))
          );
          nodeReq.on?.("error", reject);
        });
      },
      headers: {
        get: (name: string) => {
          const value = nodeReq.headers[name.toLowerCase()];
          if (Array.isArray(value)) {
            return value[0] ?? null;
          }
          return value ?? null;
        },
      },
    },
    sendResponse: (status: number, body: unknown) => {
      if (nodeRes) {
        if (nodeRes.writeHead) {
          nodeRes.writeHead(status, responseHeaders);
        } else {
          nodeRes.statusCode = status;
          for (const [key, value] of Object.entries(responseHeaders)) {
            nodeRes.setHeader?.(key, value);
          }
        }
        nodeRes.end?.(JSON.stringify(body));
        return;
      }

      return new Response(JSON.stringify(body), {
        status,
        headers: responseHeaders,
      });
    },
  };
}

/**
 * Extract the request URL path for routing decisions. Both Fetch
 * Request and NodeRequest types are supported — we only need the
 * pathname suffix.
 */
function extractRequestPath(req: Request | NodeRequest): string {
  if (req instanceof Request) {
    try {
      return new URL(req.url, "http://localhost").pathname;
    } catch {
      return "";
    }
  }
  const nodeReq = req as NodeRequest;
  return nodeReq.url ?? "";
}

/**
 * Verify HMAC-SHA256 signature using timing-safe comparison.
 *
 * The signature header is expected in the format "sha256=<hex digest>".
 */
function verifySignature(
  body: string,
  signature: string,
  signingKey: string
): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) {
    return false;
  }

  const receivedHex = signature.slice(prefix.length);
  const expectedHex = createHmac("sha256", signingKey)
    .update(body)
    .digest("hex");

  // Timing-safe comparison to prevent timing attacks
  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Create handler helper (alias for serve)
 */
export const createHandler = serve;

/**
 * Default export
 */
export default serve;
