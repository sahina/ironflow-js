import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IronflowFunction, FunctionContext } from "@ironflow/core";
import { NonRetryableError, IronflowError } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";
import { serve as realServe } from "./serve.js";
import { createFunction } from "./function.js";
import { createWebhook } from "./webhook.js";

// Mock function factory
function createMockFunction(id: string, handler: (ctx: FunctionContext) => Promise<unknown>): IronflowFunction {
  return {
    config: { id },
    handler,
  } as IronflowFunction;
}

// Create various request types for parameterized testing
interface MockNodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string | Buffer | unknown;
  on?: (event: string, callback: (data: unknown) => void) => void;
}

interface MockNodeResponse {
  statusCode?: number;
  setHeader?: ReturnType<typeof vi.fn>;
  end?: ReturnType<typeof vi.fn>;
  writeHead?: ReturnType<typeof vi.fn>;
}

// Valid push request body
const validPushRequestBody = {
  run_id: "run-123",
  function_id: "test-function",
  attempt: 1,
  event: {
    id: "evt-1",
    name: "test.event",
    data: { key: "value" },
    timestamp: "2024-01-01T00:00:00Z",
  },
  steps: [],
};

// Helper to create Fetch Request
function createFetchRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:9123/api/ironflow", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Helper to create Node stream request
function createNodeStreamRequest(body: string): MockNodeRequest {
  const chunks = [Buffer.from(body)];
  let dataCallback: ((chunk: unknown) => void) | null = null;
  let endCallback: (() => void) | null = null;

  return {
    method: "POST",
    url: "/api/ironflow",
    headers: { "content-type": "application/json" },
    on: (event: string, callback: (data?: unknown) => void) => {
      if (event === "data") {
        dataCallback = callback;
        // Simulate async data
        setTimeout(() => {
          for (const chunk of chunks) {
            dataCallback?.(chunk);
          }
        }, 0);
      } else if (event === "end") {
        endCallback = callback as () => void;
        setTimeout(() => endCallback?.(), 10);
      }
    },
  };
}

// Helper to create Node request with parsed string body
function createNodeParsedStringRequest(body: string): MockNodeRequest {
  return {
    method: "POST",
    url: "/api/ironflow",
    headers: { "content-type": "application/json" },
    body,
  };
}

// Helper to create Node request with parsed Buffer body
function createNodeParsedBufferRequest(body: string): MockNodeRequest {
  return {
    method: "POST",
    url: "/api/ironflow",
    headers: { "content-type": "application/json" },
    body: Buffer.from(body),
  };
}

// Helper to create Node request with parsed object body (express.json())
function createNodeParsedObjectRequest(body: unknown): MockNodeRequest {
  return {
    method: "POST",
    url: "/api/ironflow",
    headers: { "content-type": "application/json" },
    body,
  };
}

// Inline serve implementation for testing
function serve(config: { functions: IronflowFunction[]; signingKey?: string; skipVerification?: boolean; logger?: false }) {
  const functionMap = new Map<string, IronflowFunction>();
  for (const fn of config.functions) {
    functionMap.set(fn.config.id, fn);
  }

  return async (
    requestOrReq: Request | MockNodeRequest,
    resOrContext?: MockNodeResponse | unknown
  ): Promise<Response | void> => {
    const { request, sendResponse } = normalizeRequest(requestOrReq, resOrContext);

    try {
      const body = await request.text();

      // Signature verification (skipped in tests)
      if (config.signingKey && !config.skipVerification) {
        const signature = request.headers.get("x-ironflow-signature");
        if (!signature) {
          return sendResponse(401, {
            error: { message: "Missing signature", code: "SIGNATURE_MISSING" },
          });
        }
      }

      // Parse and validate
      let pushRequest: typeof validPushRequestBody;
      try {
        pushRequest = JSON.parse(body);
        if (!pushRequest.run_id || !pushRequest.function_id || !pushRequest.event) {
          return sendResponse(400, {
            error: { message: "Invalid request body", code: "VALIDATION_ERROR" },
          });
        }
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
      try {
        const result = await fn.handler({
          event: {
            id: pushRequest.event.id,
            name: pushRequest.event.name,
            data: pushRequest.event.data,
            timestamp: new Date(pushRequest.event.timestamp),
          },
          step: {
            run: vi.fn().mockImplementation(async (_name, fn) => fn()),
            sleep: vi.fn(),
            sleepUntil: vi.fn(),
            waitForEvent: vi.fn(),
            parallel: vi.fn(),
            map: vi.fn(),
          },
          run: {
            id: pushRequest.run_id,
            functionId: pushRequest.function_id,
            attempt: pushRequest.attempt,
            startedAt: new Date(),
          },
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as unknown as FunctionContext);

        return sendResponse(200, {
          status: "completed",
          steps: [],
          result,
        });
      } catch (error) {
        return sendResponse(200, {
          status: "failed",
          steps: [],
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: "ERROR",
            retryable: true,
          },
        });
      }
    } catch (error) {
      return sendResponse(500, {
        error: {
          message: error instanceof Error ? error.message : "Internal server error",
          code: "INTERNAL_ERROR",
        },
      });
    }
  };
}

interface NormalizedRequest {
  request: {
    text(): Promise<string>;
    headers: { get(name: string): string | null };
  };
  sendResponse: (status: number, body: unknown) => Response | void;
}

function normalizeRequest(
  request: Request | MockNodeRequest,
  responseOrContext?: MockNodeResponse | unknown
): NormalizedRequest {
  if (request instanceof Request) {
    return {
      request: {
        text: () => request.text(),
        headers: { get: (name: string) => request.headers.get(name) },
      },
      sendResponse: (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    };
  }

  const nodeReq = request;
  const nodeRes = responseOrContext as MockNodeResponse | undefined;

  return {
    request: {
      text: async () => {
        if (typeof nodeReq.body === "string") return nodeReq.body;
        if (Buffer.isBuffer(nodeReq.body)) return nodeReq.body.toString("utf-8");
        if (typeof nodeReq.body === "object" && nodeReq.body !== null) return JSON.stringify(nodeReq.body);

        return new Promise<string>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          nodeReq.on?.("data", (chunk: unknown) => {
            if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) chunks.push(chunk);
            else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
          });
          nodeReq.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          nodeReq.on?.("error", reject);
        });
      },
      headers: {
        get: (name: string) => {
          const value = nodeReq.headers[name.toLowerCase()];
          if (Array.isArray(value)) return value[0] ?? null;
          return value ?? null;
        },
      },
    },
    sendResponse: (status: number, body: unknown) => {
      if (nodeRes) {
        if (nodeRes.writeHead) {
          nodeRes.writeHead(status, { "Content-Type": "application/json" });
        } else {
          nodeRes.statusCode = status;
          nodeRes.setHeader?.("Content-Type", "application/json");
        }
        nodeRes.end?.(JSON.stringify(body));
        return;
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

describe("serve", () => {
  let testFunction: IronflowFunction;
  let handler: ReturnType<typeof serve>;

  beforeEach(() => {
    testFunction = createMockFunction("test-function", async (ctx) => {
      return { processed: true, eventName: ctx.event.name };
    });
    handler = serve({ functions: [testFunction], logger: false });
  });

  describe("Fetch Request", () => {
    it("should handle valid Fetch Request", async () => {
      const request = createFetchRequest(validPushRequestBody);
      const response = await handler(request);

      expect(response).toBeInstanceOf(Response);
      const body = (await (response as Response).json()) as Record<string, any>;
      expect(body.status).toBe("completed");
      expect(body.result).toEqual({ processed: true, eventName: "test.event" });
    });

    it("should return 400 for invalid JSON", async () => {
      const request = new Request("http://localhost:9123/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json",
      });

      const response = await handler(request);
      expect((response as Response).status).toBe(400);
      const body = (await (response as Response).json()) as Record<string, any>;
      expect(body.error.code).toBe("INVALID_JSON");
    });

    it("should return 404 for unknown function", async () => {
      const request = createFetchRequest({ ...validPushRequestBody, function_id: "unknown" });
      const response = await handler(request);

      expect((response as Response).status).toBe(404);
      const body = (await (response as Response).json()) as Record<string, any>;
      expect(body.error.code).toBe("FUNCTION_NOT_FOUND");
    });

    it("should return 400 for missing required fields", async () => {
      const request = createFetchRequest({ function_id: "test-function" });
      const response = await handler(request);

      expect((response as Response).status).toBe(400);
      const body = (await (response as Response).json()) as Record<string, any>;
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Node IncomingMessage (stream)", () => {
    it("should read body from stream", async () => {
      const nodeReq = createNodeStreamRequest(JSON.stringify(validPushRequestBody));
      const nodeRes: MockNodeResponse = {
        statusCode: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.end).toHaveBeenCalled();
      const responseBody = JSON.parse(assertDefined(nodeRes.end!.mock.calls[0])[0]);
      expect(responseBody.status).toBe("completed");
    });
  });

  describe("Node IncomingMessage (string body)", () => {
    it("should read pre-parsed string body", async () => {
      const nodeReq = createNodeParsedStringRequest(JSON.stringify(validPushRequestBody));
      const nodeRes: MockNodeResponse = {
        statusCode: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.end).toHaveBeenCalled();
      const responseBody = JSON.parse(assertDefined(nodeRes.end!.mock.calls[0])[0]);
      expect(responseBody.status).toBe("completed");
    });
  });

  describe("Node IncomingMessage (Buffer body)", () => {
    it("should read pre-parsed Buffer body", async () => {
      const nodeReq = createNodeParsedBufferRequest(JSON.stringify(validPushRequestBody));
      const nodeRes: MockNodeResponse = {
        statusCode: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.end).toHaveBeenCalled();
      const responseBody = JSON.parse(assertDefined(nodeRes.end!.mock.calls[0])[0]);
      expect(responseBody.status).toBe("completed");
    });
  });

  describe("Node IncomingMessage (object body)", () => {
    it("should read pre-parsed object body", async () => {
      const nodeReq = createNodeParsedObjectRequest(validPushRequestBody);
      const nodeRes: MockNodeResponse = {
        statusCode: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.end).toHaveBeenCalled();
      const responseBody = JSON.parse(assertDefined(nodeRes.end!.mock.calls[0])[0]);
      expect(responseBody.status).toBe("completed");
    });
  });

  describe("parameterized tests", () => {
    const requestFactories = [
      {
        name: "Fetch Request",
        create: (body: unknown) => ({ request: createFetchRequest(body), response: undefined }),
        getResult: async (response: Response) => response.json(),
      },
      {
        name: "Node string body",
        create: (body: unknown) => ({
          request: createNodeParsedStringRequest(JSON.stringify(body)),
          response: { end: vi.fn(), setHeader: vi.fn() } as MockNodeResponse,
        }),
        getResult: async (_: unknown, res: MockNodeResponse) => JSON.parse(assertDefined(res.end!.mock.calls[0])[0]),
      },
      {
        name: "Node Buffer body",
        create: (body: unknown) => ({
          request: createNodeParsedBufferRequest(JSON.stringify(body)),
          response: { end: vi.fn(), setHeader: vi.fn() } as MockNodeResponse,
        }),
        getResult: async (_: unknown, res: MockNodeResponse) => JSON.parse(assertDefined(res.end!.mock.calls[0])[0]),
      },
      {
        name: "Node object body",
        create: (body: unknown) => ({
          request: createNodeParsedObjectRequest(body),
          response: { end: vi.fn(), setHeader: vi.fn() } as MockNodeResponse,
        }),
        getResult: async (_: unknown, res: MockNodeResponse) => JSON.parse(assertDefined(res.end!.mock.calls[0])[0]),
      },
    ];

    describe.each(requestFactories)("$name", ({ create, getResult }) => {
      it("should call handler with parsed request", async () => {
        const { request, response } = create(validPushRequestBody);
        const result = await handler(request, response);
        const body = await getResult(result as Response, response as MockNodeResponse);

        expect(body.status).toBe("completed");
        expect(body.result.processed).toBe(true);
      });

      it("should handle function errors", async () => {
        const errorFunction = createMockFunction("error-function", async () => {
          throw new Error("Test error");
        });
        const errorHandler = serve({ functions: [errorFunction], logger: false });

        const { request, response } = create({ ...validPushRequestBody, function_id: "error-function" });
        const result = await errorHandler(request, response);
        const body = await getResult(result as Response, response as MockNodeResponse);

        expect(body.status).toBe("failed");
        expect(body.error.message).toBe("Test error");
      });
    });
  });

  describe("signature verification", () => {
    it("should return 401 when signature is missing and required", async () => {
      const signedHandler = serve({
        functions: [testFunction],
        signingKey: "test-key",
        logger: false,
      });

      const request = createFetchRequest(validPushRequestBody);
      const response = await signedHandler(request);

      expect((response as Response).status).toBe(401);
      const body = (await (response as Response).json()) as Record<string, any>;
      expect(body.error.code).toBe("SIGNATURE_MISSING");
    });

    it("should skip verification when skipVerification is true", async () => {
      const signedHandler = serve({
        functions: [testFunction],
        signingKey: "test-key",
        skipVerification: true,
        logger: false,
      });

      const request = createFetchRequest(validPushRequestBody);
      const response = await signedHandler(request);

      expect((response as Response).status).toBe(200);
    });
  });

  describe("response formats", () => {
    it("should use writeHead for Node response when available", async () => {
      const nodeReq = createNodeParsedObjectRequest(validPushRequestBody);
      const nodeRes: MockNodeResponse = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    });

    it("should use setHeader for Node response when writeHead unavailable", async () => {
      const nodeReq = createNodeParsedObjectRequest(validPushRequestBody);
      const nodeRes: MockNodeResponse = {
        statusCode: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await handler(nodeReq, nodeRes);

      expect(nodeRes.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
      expect(nodeRes.statusCode).toBe(200);
    });
  });
});

// ============================================================================
// Tests for the REAL serve() function (imported from ./serve.ts)
// ============================================================================

describe("serve (real module)", () => {
  // Create test functions using the real createFunction helper
  const testFn = createFunction(
    { id: "test-fn", triggers: [{ event: "test.event" }] },
    async ({ event, step }) => {
      const result = await step.run("process", async () => {
        return { processed: true, eventName: event.name };
      });
      return result;
    }
  );

  const failingFn = createFunction(
    { id: "failing-fn", triggers: [{ event: "test.event" }] },
    async () => {
      throw new Error("intentional failure");
    }
  );

  // Helper to create a valid push request body for the real serve handler
  function createRealPushBody(overrides: Record<string, unknown> = {}) {
    return {
      run_id: "run_1",
      function_id: "test-fn",
      attempt: 1,
      event: {
        id: "evt_1",
        name: "test.event",
        data: { id: "1" },
        timestamp: "2024-01-01T00:00:00Z",
      },
      steps: [],
      ...overrides,
    };
  }

  it("returns a handler function", () => {
    const handler = realServe({ functions: [testFn], logger: false });
    expect(typeof handler).toBe("function");
  });

  it("executes function successfully with Fetch Request", async () => {
    const handler = realServe({ functions: [testFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ processed: true, eventName: "test.event" });
  });

  it("returns steps from execution context", async () => {
    const handler = realServe({ functions: [testFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    const body = (await response.json()) as Record<string, any>;
    expect(body.steps).toBeInstanceOf(Array);
    expect(body.steps.length).toBeGreaterThanOrEqual(1);
    expect(body.steps[0].name).toBe("process");
    expect(body.steps[0].status).toBe("completed");
  });

  it("returns 404 for unknown function", async () => {
    const handler = realServe({ functions: [testFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody({ function_id: "nonexistent" })),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("FUNCTION_NOT_FOUND");
  });

  it("returns 400 for invalid JSON", async () => {
    const handler = realServe({ functions: [testFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("returns 400 for validation errors (missing required fields)", async () => {
    const handler = realServe({ functions: [testFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ function_id: "test-fn" }),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 when signature is missing and verification enabled", async () => {
    const handler = realServe({ functions: [testFn], signingKey: "test-secret", logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("SIGNATURE_MISSING");
  });

  it("returns 401 for invalid signature", async () => {
    const handler = realServe({ functions: [testFn], signingKey: "test-secret", logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ironflow-signature": "sha256=invalid",
      },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("SIGNATURE_INVALID");
  });

  it("handles function errors with failed status", async () => {
    const handler = realServe({ functions: [failingFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody({ function_id: "failing-fn" })),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("failed");
    expect(body.error.message).toBe("intentional failure");
    expect(body.error.retryable).toBe(false);
  });

  it("handles sleep yield with yielded status", async () => {
    const sleepFn = createFunction(
      { id: "sleep-fn", triggers: [{ event: "test.event" }] },
      async ({ step }) => {
        await step.sleep("wait-a-bit", "1h");
        return { done: true };
      }
    );

    const handler = realServe({ functions: [sleepFn], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody({ function_id: "sleep-fn" })),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("yielded");
    expect(body.yield.type).toBe("sleep");
    expect(body.yield.step_id).toContain("wait-a-bit");
  });

  it("skips verification when skipVerification is true even with signingKey", async () => {
    const handler = realServe({
      functions: [testFn],
      signingKey: "test-secret",
      skipVerification: true,
      logger: false,
    });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("completed");
  });

  it("includes environment header in response", async () => {
    const handler = realServe({
      functions: [testFn],
      skipVerification: true,
      logger: false,
      environment: "testing",
    });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRealPushBody()),
    });
    const response = await handler(request) as Response;
    expect(response.headers.get("x-ironflow-environment")).toBe("testing");
  });

  describe("saga compensation", () => {
    it("runs compensations and includes them in steps on non-retryable error", async () => {
      let compensated = false;

      const sagaFn = createFunction(
        { id: "saga-fn", triggers: [{ event: "test.event" }] },
        async ({ step }) => {
          await step.run("charge-payment", async () => ({ txId: "tx-1" }));
          step.compensate("charge-payment", async () => { compensated = true; });
          throw new NonRetryableError("shipping address invalid");
        }
      );

      const handler = realServe({ functions: [sagaFn], skipVerification: true, logger: false });
      const request = new Request("http://localhost/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRealPushBody({ function_id: "saga-fn" })),
      });
      const response = await handler(request) as Response;
      const body = (await response.json()) as Record<string, any>;

      expect(body.status).toBe("failed");
      expect(body.error.retryable).toBe(false);
      expect(compensated).toBe(true);

      const compSteps = body.steps.filter((s: { type: string }) => s.type === "compensate");
      expect(compSteps).toHaveLength(1);
      expect(compSteps[0].name).toBe("compensate:charge-payment");
      expect(compSteps[0].compensation_for).toBe("charge-payment");
      expect(compSteps[0].status).toBe("completed");
    });

    it("does NOT run compensations on retryable error", async () => {
      let compensated = false;

      const retryableFn = createFunction(
        { id: "retryable-fn", triggers: [{ event: "test.event" }] },
        async ({ step }) => {
          await step.run("charge-payment", async () => ({ txId: "tx-1" }));
          step.compensate("charge-payment", async () => { compensated = true; });
          throw new IronflowError("temporary network error", { retryable: true });
        }
      );

      const handler = realServe({ functions: [retryableFn], skipVerification: true, logger: false });
      const request = new Request("http://localhost/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRealPushBody({ function_id: "retryable-fn" })),
      });
      const response = await handler(request) as Response;
      const body = (await response.json()) as Record<string, any>;

      expect(body.status).toBe("failed");
      expect(body.error.retryable).toBe(true);
      expect(compensated).toBe(false);

      const compSteps = body.steps.filter((s: { type: string }) => s.type === "compensate");
      expect(compSteps).toHaveLength(0);
    });

    it("runs compensations in reverse order across multiple steps", async () => {
      const order: string[] = [];

      const multiStepFn = createFunction(
        { id: "multi-step-fn", triggers: [{ event: "test.event" }] },
        async ({ step }) => {
          await step.run("step-a", async () => "a");
          step.compensate("step-a", async () => { order.push("undo-a"); });

          await step.run("step-b", async () => "b");
          step.compensate("step-b", async () => { order.push("undo-b"); });

          await step.run("step-c", async () => "c");
          step.compensate("step-c", async () => { order.push("undo-c"); });

          throw new NonRetryableError("terminal failure");
        }
      );

      const handler = realServe({ functions: [multiStepFn], skipVerification: true, logger: false });
      const request = new Request("http://localhost/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRealPushBody({ function_id: "multi-step-fn" })),
      });
      await (await handler(request) as Response).json();

      expect(order).toEqual(["undo-c", "undo-b", "undo-a"]);
    });

    it("compensation step IDs follow runId:compensate:stepName:0 format", async () => {
      const sagaFn = createFunction(
        { id: "id-format-fn", triggers: [{ event: "test.event" }] },
        async ({ step }) => {
          await step.run("pay", async () => "ok");
          step.compensate("pay", async () => {});
          throw new NonRetryableError("fail");
        }
      );

      const handler = realServe({ functions: [sagaFn], skipVerification: true, logger: false });
      const request = new Request("http://localhost/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRealPushBody({ run_id: "run_abc", function_id: "id-format-fn" })),
      });
      const body = (await (await handler(request) as Response).json()) as Record<string, any>;

      const compStep = body.steps.find((s: { type: string }) => s.type === "compensate");
      expect(compStep?.id).toBe("run_abc:compensate:pay:0");
    });

    it("runs compensations inside parallel branches", async () => {
      const compensated: string[] = [];

      const parallelFn = createFunction(
        { id: "parallel-saga-fn", triggers: [{ event: "test.event" }] },
        async ({ step }) => {
          await step.parallel("provision", [
            async (s) => {
              await s.run("create-db", async () => "db-1");
              s.compensate("create-db", async () => { compensated.push("delete-db"); });
              return "db";
            },
            async (s) => {
              await s.run("create-cache", async () => "cache-1");
              s.compensate("create-cache", async () => { compensated.push("delete-cache"); });
              return "cache";
            },
          ] as [(s: typeof step) => Promise<string>, (s: typeof step) => Promise<string>]);

          throw new NonRetryableError("downstream failure");
        }
      );

      const handler = realServe({ functions: [parallelFn], skipVerification: true, logger: false });
      const request = new Request("http://localhost/api/ironflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRealPushBody({ function_id: "parallel-saga-fn" })),
      });
      const body = (await (await handler(request) as Response).json()) as Record<string, any>;

      expect(body.status).toBe("failed");
      expect(compensated).toHaveLength(2);
      expect(compensated).toContain("delete-db");
      expect(compensated).toContain("delete-cache");
    });
  });
});

// ============================================================================
// Webhook routing tests for the REAL serve() function
// ============================================================================

describe("webhook routing", () => {
  const testWebhook = createWebhook({
    id: "test-provider",
    verify: (req) => {
      if (req.headers["x-test-sig"] !== "valid") throw new Error("bad sig");
    },
    transform: (payload: any) => ({
      name: `webhook/test.${payload.type}`,
      data: payload.data,
      idempotencyKey: payload.id,
    }),
  });

  const testFn = createFunction(
    { id: "wh-test-fn", triggers: [{ event: "test.event" }] },
    async ({ event }) => ({ processed: true, eventName: event.name })
  );

  it("should verify and transform webhook successfully", async () => {
    const handler = realServe({ functions: [testFn], webhooks: [testWebhook], skipVerification: true, logger: false });
    const request = new Request("http://localhost/webhooks/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-sig": "valid" },
      body: JSON.stringify({ type: "payment.completed", data: { amount: 100 }, id: "evt-1" }),
    });
    const response = await handler(request) as Response;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("accepted");
    expect(body.event.name).toBe("webhook/test.payment.completed");
    expect(body.event.data).toEqual({ amount: 100 });
  });

  it("should return 401 when webhook verification fails", async () => {
    const handler = realServe({ functions: [testFn], webhooks: [testWebhook], skipVerification: true, logger: false });
    const request = new Request("http://localhost/webhooks/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-sig": "wrong" },
      body: JSON.stringify({ type: "payment.completed", data: { amount: 100 }, id: "evt-1" }),
    });
    const response = await handler(request) as Response;

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("VERIFY_FAILED");
  });

  it("should return 404 for unknown webhook provider", async () => {
    const handler = realServe({ functions: [testFn], webhooks: [testWebhook], skipVerification: true, logger: false });
    const request = new Request("http://localhost/webhooks/unknown-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test", data: {} }),
    });
    const response = await handler(request) as Response;

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("WEBHOOK_NOT_FOUND");
  });

  it("should return 400 when transform fails", async () => {
    const badTransformWebhook = createWebhook({
      id: "bad-transform",
      verify: () => {},
      transform: () => { throw new Error("bad payload"); },
    });

    const handler = realServe({ functions: [testFn], webhooks: [badTransformWebhook], skipVerification: true, logger: false });
    const request = new Request("http://localhost/webhooks/bad-transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test", data: {} }),
    });
    const response = await handler(request) as Response;

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("TRANSFORM_FAILED");
  });

  it("should route non-webhook URLs to function handler", async () => {
    const handler = realServe({ functions: [testFn], webhooks: [testWebhook], skipVerification: true, logger: false });
    const request = new Request("http://localhost/api/ironflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: "run_1",
        function_id: "wh-test-fn",
        attempt: 1,
        event: {
          id: "evt_1",
          name: "test.event",
          data: { id: "1" },
          timestamp: "2024-01-01T00:00:00Z",
        },
        steps: [],
      }),
    });
    const response = await handler(request) as Response;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("completed");
  });
});

describe("serve duplicate function detection", () => {
  it("should warn on duplicate function IDs", () => {
    const fn1 = createMockFunction("my-func", async () => "a");
    const fn2 = createMockFunction("my-func", async () => "b");
    const warnSpy = vi.fn();

    realServe({
      functions: [fn1, fn2],
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate function ID "my-func"')
    );
  });

  it("should not warn when function IDs are unique", () => {
    const fn1 = createMockFunction("func-a", async () => "a");
    const fn2 = createMockFunction("func-b", async () => "b");
    const warnSpy = vi.fn();

    realServe({
      functions: [fn1, fn2],
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
    });

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Duplicate function ID")
    );
  });
});
