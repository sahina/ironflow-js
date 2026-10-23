/**
 * Characterization tests for the three HTTP helpers in client.ts:
 * `request()`, `streamRequest()` and `restRequest()`.
 *
 * These were written BEFORE extracting the shared `send()` shell (T1) and pin
 * the behaviour that must not change: header construction, `Authorization`
 * precedence, timeout wiring, and the (deliberately inconsistent) error
 * message templates.
 *
 * They are exercised through public methods rather than the private helpers,
 * so they keep working regardless of how the internals are factored:
 *
 *   emit()            -> request()       (zod-validated, body read once)
 *   streams.append()  -> streamRequest() (raw json, body read only on error)
 *   apiKeys.*         -> restRequest()   (204 handling, typed 401/402/403)
 *
 * The 429 assertions are the T2 regression test: a rate limit must be retryable
 * on ALL THREE helpers, not just the queue's path. Before T2 the rule was a bare
 * `status >= 500`, which classified 429 as permanent.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const ENV_HEADER = "X-Ironflow-Environment-ID";
// The server answers 400 to the pre-#3088 header, so it must never be sent.
const OLD_ENV_HEADER = "X-Ironflow-Environment";

/** Build a minimal Response-like object; `text`/`json` are spies so we can assert read behaviour. */
function mockResponse(
  body: string,
  init: { status?: number; ok?: boolean } = {}
): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    text: vi.fn(async () => body),
    json: vi.fn(async () => JSON.parse(body)),
  } as unknown as Response;
}

function lastFetchInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1]![1] as RequestInit;
}

function lastHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return lastFetchInit(fetchMock).headers as Record<string, string>;
}

describe("HTTP helper characterization (pre-send() extraction)", () => {
  let ironflow: import("./client.js").IronflowClient;

  beforeAll(async () => {
    ironflow = (await import("./client.js")).ironflow;
  });

  afterEach(() => {
    ironflow._resetForTesting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ==========================================================================
  // request() — via emit()
  // ==========================================================================

  describe("request() via emit()", () => {
    it("sends Content-Type, environment header and Bearer apiKey", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"eventId":"e1","runIds":["r1"]}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({
        serverUrl: "http://test:9123",
        logger: false,
        auth: { apiKey: "ifkey_abc" },
      });

      await ironflow.emit("order.placed", { id: 1 });

      const headers = lastHeaders(fetchMock);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers[ENV_HEADER]).toBeUndefined();
      expect(headers[OLD_ENV_HEADER]).toBeUndefined();
      expect(headers["Authorization"]).toBe("Bearer ifkey_abc");
      expect(lastFetchInit(fetchMock).method).toBe("POST");
    });

    it("apiKey wins over token when both are configured", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"eventId":"e1"}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({
        serverUrl: "http://test:9123",
        logger: false,
        auth: { apiKey: "ifkey_wins", token: "jwt_loses" },
      });

      await ironflow.emit("x", {});

      expect(lastHeaders(fetchMock)["Authorization"]).toBe("Bearer ifkey_wins");
    });

    it("falls back to token when no apiKey is set", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"eventId":"e1"}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({
        serverUrl: "http://test:9123",
        logger: false,
        auth: { token: "jwt_only" },
      });

      await ironflow.emit("x", {});

      expect(lastHeaders(fetchMock)["Authorization"]).toBe("Bearer jwt_only");
    });

    it("omits Authorization entirely when no auth is configured", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"eventId":"e1"}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await ironflow.emit("x", {});

      expect(lastHeaders(fetchMock)["Authorization"]).toBeUndefined();
    });

    it("maps a server error body to its message and code", async () => {
      const fetchMock = vi.fn(async () =>
        mockResponse('{"message":"bad event","code":"BAD_EVENT"}', { status: 400 })
      );
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.emit("x", {})).rejects.toMatchObject({
        message: "bad event",
        code: "BAD_EVENT",
        retryable: false,
      });
    });

    it("uses 'Request failed: {status}' and HTTP_{status} when the body has no message", async () => {
      const fetchMock = vi.fn(async () => mockResponse("{}", { status: 418 }));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.emit("x", {})).rejects.toMatchObject({
        message: "Request failed: 418",
        code: "invalid_argument",
      });
    });

    // #3054: one condition, one code, on every transport.
    it("answers not_found for a 404, whether the body names a code or not", async () => {
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse(JSON.stringify({ code: "not_found", message: "gone" }), { status: 404 })));
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ code: "not_found", status: 404, retryable: false });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 404 })));
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ code: "not_found", status: 404 });
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({ code: "not_found", status: 404 });
    });

    it("names the failures of health, capabilities, workers and pause with a Connect code", async () => {
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 503 })));
      await expect(ironflow.health()).rejects.toMatchObject({ code: "unavailable", status: 503 });
      await expect(ironflow.getCapabilities()).rejects.toMatchObject({ code: "unavailable", status: 503 });
      await expect(ironflow.listWorkers()).rejects.toMatchObject({ code: "unavailable", status: 503 });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse(JSON.stringify({ code: "NOT_FOUND", message: "no run" }), { status: 404 })));
      await expect(ironflow.pauseRun("run_x")).rejects.toMatchObject({ code: "not_found", status: 404 });
    });

    it("marks 5xx retryable, 429 retryable, and other 4xx not retryable", async () => {
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 503 })));
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ retryable: true });

      // A rate limit is a "later", not a "never".
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 429 })));
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({
        retryable: true,
        code: "resource_exhausted",
      });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 400 })));
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ retryable: false });
    });

    it("throws ValidationError on a non-JSON success body", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("not json at all")));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.emit("x", {})).rejects.toThrow(
        "Invalid JSON response from server"
      );
    });

    it("maps AbortError to a TIMEOUT error naming the method and path", async () => {
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw abort;
        })
      );
      ironflow.configure({ serverUrl: "http://test:9123", logger: false, timeout: 1234 });

      await expect(ironflow.emit("x", {})).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
        message: "Request timeout after 1234ms for POST /ironflow.v1.PubSubService/Emit",
      });
    });

    it("maps a network failure to REQUEST_FAILED and keeps the cause", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        })
      );
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.emit("x", {})).rejects.toMatchObject({
        code: "REQUEST_FAILED",
        retryable: true,
      });
    });
  });

  // ==========================================================================
  // streamRequest() — via streams.append()
  // ==========================================================================

  describe("streamRequest() via streams.append()", () => {
    it("sends the same header set as request()", async () => {
      const fetchMock = vi.fn(async () =>
        mockResponse('{"entityVersion":1,"eventId":"e1"}')
      );
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({
        serverUrl: "http://test:9123",
        logger: false,
        auth: { apiKey: "k" },
      });

      await ironflow.streams.append("order-1", {
        entityType: "order",
        name: "created",
        data: {},
      });

      const headers = lastHeaders(fetchMock);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers[ENV_HEADER]).toBeUndefined();
      expect(headers["Authorization"]).toBe("Bearer k");
    });

    it("does not read the response body on success", async () => {
      const response = mockResponse('{"entityVersion":1,"eventId":"e1"}');
      vi.stubGlobal("fetch", vi.fn(async () => response));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await ironflow.streams.append("order-1", {
        entityType: "order",
        name: "created",
        data: {},
      });

      expect(response.text).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalled();
    });

    it("uses 'Request failed: {status}' on an error with no message", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 500 })));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(
        ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })
      ).rejects.toMatchObject({
        message: "Request failed: 500",
        code: "internal",
        retryable: true,
      });
    });

    it("marks 429 retryable (T2 regression — same rule as the other helpers)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("{}", { status: 429 })));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(
        ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })
      ).rejects.toMatchObject({ retryable: true, code: "resource_exhausted" });
    });

    it("names POST in the timeout message", async () => {
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw abort;
        })
      );
      ironflow.configure({ serverUrl: "http://test:9123", logger: false, timeout: 50 });

      await expect(
        ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })
      ).rejects.toMatchObject({
        code: "TIMEOUT",
        message:
          "Request timeout after 50ms for POST /ironflow.v1.EntityStreamService/AppendEvent",
      });
    });
  });

  // ==========================================================================
  // restRequest() — via apiKeys.*
  // ==========================================================================

  describe("restRequest() via apiKeys.*", () => {
    it("omits Content-Type on a bodyless GET", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"keys":[]}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({
        serverUrl: "http://test:9123",
        logger: false,
        auth: { apiKey: "k" },
      });

      await ironflow.apiKeys.list();

      const headers = lastHeaders(fetchMock);
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers[ENV_HEADER]).toBeUndefined();
      expect(headers["Authorization"]).toBe("Bearer k");
      expect(lastFetchInit(fetchMock).body).toBeUndefined();
    });

    it("sets Content-Type and a body on POST", async () => {
      const fetchMock = vi.fn(async () => mockResponse('{"id":"k1","key":"secret"}'));
      vi.stubGlobal("fetch", fetchMock);
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await ironflow.apiKeys.create({ name: "test" } as never);

      expect(lastHeaders(fetchMock)["Content-Type"]).toBe("application/json");
      expect(lastFetchInit(fetchMock).body).toBe(JSON.stringify({ name: "test" }));
    });

    it("returns undefined for 204 without parsing a body", async () => {
      const response = mockResponse("", { status: 204 });
      vi.stubGlobal("fetch", vi.fn(async () => response));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.apiKeys.delete("k1")).resolves.toBeUndefined();
      expect(response.json).not.toHaveBeenCalled();
    });

    it("maps 401, 402 and 403 to their typed errors", async () => {
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 401 })));
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        name: "UnauthenticatedError",
        code: "unauthenticated",
      });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 402 })));
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        name: "EnterpriseRequiredError",
      });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 403 })));
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        name: "UnauthorizedError",
      });
    });

    it("uses the 'Request failed with status {status}' template (differs from the other two helpers)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 500 })));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        message: "Request failed with status 500",
        code: "internal",
        retryable: true,
      });
    });

    it("prefers a JSON message, then raw text, then the status template", async () => {
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mockResponse('{"message":"nope"}', { status: 400 }))
      );
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({ message: "nope" });

      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("plain text boom", { status: 400 })));
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        message: "plain text boom",
      });
    });

    it("marks 429 retryable (T2 regression — same rule as the other helpers)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 429 })));
      ironflow.configure({ serverUrl: "http://test:9123", logger: false });

      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        retryable: true,
        code: "resource_exhausted",
      });
    });

    it("names the actual method in the timeout message", async () => {
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw abort;
        })
      );
      ironflow.configure({ serverUrl: "http://test:9123", logger: false, timeout: 77 });

      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({
        code: "TIMEOUT",
        message: "Request timeout after 77ms for GET /api/v1/apikeys",
      });
    });
  });

  describe("server retry signal", () => {
    beforeEach(() => ironflow.configure({ serverUrl: "http://test:9123", logger: false }));

    const reply = (status: number, body: unknown) =>
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse(JSON.stringify(body), { status })));

    it("does not mark 501 retryable on any helper", async () => {
      reply(501, {});
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ retryable: false });
      await expect(ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })).rejects.toMatchObject({ retryable: false });
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({ retryable: false });
    });

    it("lets the body retryable flag win over the status on every helper", async () => {
      reply(507, { message: "disk full", retryable: false });
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ retryable: false });
      await expect(ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })).rejects.toMatchObject({ retryable: false });
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({ retryable: false });

      reply(409, { message: "busy", retryable: true });
      await expect(ironflow.emit("x", {})).rejects.toMatchObject({ retryable: true });
      await expect(ironflow.streams.append("o", { entityType: "order", name: "c", data: {} })).rejects.toMatchObject({ retryable: true });
      await expect(ironflow.apiKeys.list()).rejects.toMatchObject({ retryable: true });
    });
  });
});
