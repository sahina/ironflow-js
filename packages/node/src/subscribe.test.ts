import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { patterns } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";

// ============================================================================
// Mock WebSocket
// ============================================================================

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Error) => void) | null = null;

  close = vi.fn((code?: number) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  });

  send = vi.fn();

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code: number = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let mockWs: MockWebSocket;
let lastWsUrl = "";
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  // Replace global WebSocket with mock
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super();
      mockWs = this;
      lastWsUrl = url;
      // Auto-connect after microtask
      queueMicrotask(() => this.simulateOpen());
    }
  };
  // Set static constants on the mock constructor
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
  (globalThis as any).WebSocket.CONNECTING = MockWebSocket.CONNECTING;
  (globalThis as any).WebSocket.CLOSING = MockWebSocket.CLOSING;
  (globalThis as any).WebSocket.CLOSED = MockWebSocket.CLOSED;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Helper: import fresh module per test to avoid state leakage
async function importModule() {
  return await import("./subscribe.js");
}

// ============================================================================
// Pattern Tests
// ============================================================================

describe("patterns", () => {
  it("includes secret patterns", () => {
    expect(patterns.allSecrets()).toBe("system.secret.*");
    expect(patterns.secret("API_KEY")).toBe("system.secret.API_KEY.*");
    expect(patterns.secretAction("updated")).toBe("system.secret.*.updated");
  });

  it("includes run patterns", () => {
    expect(patterns.allRuns()).toBe("system.run.>");
    expect(patterns.run("abc")).toBe("system.run.abc.>");
  });

  it("includes function patterns", () => {
    expect(patterns.allFunctions()).toBe("system.function.>");
    expect(patterns.function("fn-1")).toBe("system.function.fn-1.>");
  });

  it("includes user event patterns", () => {
    expect(patterns.allUserEvents()).toBe("events:>");
    expect(patterns.userEvent("order.placed")).toBe("events:order.placed");
  });
});

// ============================================================================
// Connection Tests
// ============================================================================

describe("SubscriptionClient", () => {
  describe("connect", () => {
    it("connects to server", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      expect(client.isConnected).toBe(true);
      expect(client.connectionState).toBe("connected");

      client.close();
    });

    it("falls back to IRONFLOW_API_KEY for the token param", async () => {
      vi.stubEnv("IRONFLOW_API_KEY", "env-key");
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      expect(lastWsUrl).toContain("token=env-key");

      client.close();
    });

    it("prefers an explicit apiKey over IRONFLOW_API_KEY", async () => {
      vi.stubEnv("IRONFLOW_API_KEY", "env-key");
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
        apiKey: "explicit-key",
      });

      await client.connect();

      expect(lastWsUrl).toContain("token=explicit-key");
      expect(lastWsUrl).not.toContain("env-key");

      client.close();
    });

    it("no-ops if already connected", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();
      await client.connect(); // Should not throw

      expect(client.isConnected).toBe(true);

      client.close();
    });

    it("throws if client is closed", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      client.close();

      await expect(client.connect()).rejects.toThrow("Client is closed");
    });

    it("calls onConnectionChange callback", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      const states: string[] = [];
      client.onConnectionChange((state) => states.push(state));

      await client.connect();

      expect(states).toContain("connecting");
      expect(states).toContain("connected");

      client.close();
    });
  });

  describe("close", () => {
    it("disconnects and rejects pending subscriptions", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      // Start a subscribe but don't resolve it — catch immediately to prevent unhandled rejection
      const subPromise = client
        .subscribe("system.run.>", {
          onEvent: () => {},
        })
        .catch((err: Error) => err);

      // Close immediately
      client.close();

      const result = await subPromise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("Client closed");

      expect(client.isConnected).toBe(false);
    });
  });

  // ============================================================================
  // Subscribe Tests
  // ============================================================================

  describe("subscribe", () => {
    it("subscribes to a pattern", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const subPromise = client.subscribe("system.secret.*", {
        onEvent: () => {},
      });

      // Simulate server response
      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.secret.*",
            status: "ok",
            subscriptionId: "sub_123",
          },
        ],
      });

      const sub = await subPromise;
      expect(sub.id).toBe("sub_123");
      expect(sub.pattern).toBe("system.secret.*");

      client.close();
    });

    it("throws if not connected", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await expect(
        client.subscribe("system.run.>", { onEvent: () => {} }),
      ).rejects.toThrow("Not connected");
    });

    it("throws for duplicate pattern", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const subPromise = client.subscribe("system.secret.*", {
        onEvent: () => {},
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.secret.*",
            status: "ok",
            subscriptionId: "sub_1",
          },
        ],
      });

      await subPromise;

      await expect(
        client.subscribe("system.secret.*", { onEvent: () => {} }),
      ).rejects.toThrow("Already subscribed");

      client.close();
    });

    it("rejects a pending subscribe when the server answers a generic error frame", async () => {
      // #2056. `subscribe()` settles only from `subscription_result`, so a server answering the
      // GENERIC error frame — what it sends for "PubSub not configured" — left this promise
      // pending forever on a socket that was up: no timeout, no rejection, and a subscription
      // that never existed and never said so.
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });
      await client.connect();

      const subPromise = client.subscribe("system.run.>", { onEvent: () => {} });

      mockWs.simulateMessage({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "PubSub not configured",
      });

      await expect(subPromise).rejects.toThrow("PubSub not configured");

      client.close();
    });

    it("still fans a generic error frame out to the global handlers", async () => {
      // Settling pending is ADDITIONAL, not a replacement: consumers registered on `onError`
      // expect this frame, and a fix that swallowed it would be a second bug.
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });
      await client.connect();

      const seen: { code: string }[] = [];
      client.onError((e) => seen.push({ code: e.code }));
      const subPromise = client
        .subscribe("system.run.>", { onEvent: () => {} })
        .catch(() => {});

      mockWs.simulateMessage({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "PubSub not configured",
      });

      await subPromise;
      expect(seen).toEqual([{ code: "INTERNAL_ERROR" }]);

      client.close();
    });

    it("clears the pending entry, so the SAME pattern can be retried", async () => {
      // THE HALF THAT MAKES A RETRY POSSIBLE. `subscribe` writes `pending` synchronously and its
      // duplicate check reads `patternToId.has(p) || pending.has(p)`, so a rejection that left the
      // entry behind would poison the pattern for the life of the client: every retry throwing
      // `Already subscribed to pattern` rather than reaching the server.
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });
      await client.connect();

      await expect(
        (async () => {
          const p = client.subscribe("system.run.>", { onEvent: () => {} });
          mockWs.simulateMessage({
            type: "error",
            code: "INTERNAL_ERROR",
            message: "PubSub not configured",
          });
          return p;
        })(),
      ).rejects.toThrow();

      // The retry reaches the server rather than throwing locally, and succeeds.
      const retry = client.subscribe("system.run.>", { onEvent: () => {} });
      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.run.>",
            status: "ok",
            subscriptionId: "sub_after_retry",
          },
        ],
      });
      const sub = await retry;
      expect(sub.id).toBe("sub_after_retry");

      client.close();
    });

    it("sends subscribe request with options", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      // Catch the pending promise to prevent unhandled rejection on close
      const subPromise = client
        .subscribe("system.run.>", {
          replay: 10,
          includeMetadata: true,
          onEvent: () => {},
        })
        .catch(() => {});

      // Check the sent message
      const sent = JSON.parse(assertDefined(mockWs.send.mock.calls[0])[0]);
      expect(sent.type).toBe("subscribe");
      expect(sent.subscription.pattern).toBe("system.run.>");
      expect(sent.subscription.options.replay).toBe(10);
      expect(sent.subscription.options.includeMetadata).toBe(true);

      client.close();
      await subPromise;
    });

    it("sends a resume cursor in the subscribe request", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });
      await client.connect();

      const subPromise = client
        .subscribe("orders.*", {
          startAfterSequence: 400,
          onEvent: () => {},
        })
        .catch(() => {});

      const sent = JSON.parse(assertDefined(mockWs.send.mock.calls[0])[0]);
      expect(sent.subscription.options).toMatchObject({
        startAfterSequence: 400,
        includeMetadata: true,
      });

      client.close();
      await subPromise;
    });

    it.each([
      {
        name: "replay",
        options: { replay: 3, startAfterSequence: 400 },
        message: "replay and start_after_sequence are mutually exclusive",
      },
      {
        name: "consumer group",
        options: { consumerGroup: "processors", startAfterSequence: 400 },
        message: "start_after_sequence cannot be combined with consumer_group",
      },
    ])(
      "surfaces the server rejection for cursor plus $name",
      async ({ options, message }) => {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
        });
        await client.connect();

        const subPromise = client.subscribe("orders.*", {
          ...options,
          onEvent: () => {},
        });
        const sent = JSON.parse(assertDefined(mockWs.send.mock.calls[0])[0]);
        expect(sent.subscription.options).toMatchObject(options);

        mockWs.simulateMessage({
          type: "subscription_result",
          results: [
            {
              pattern: "orders.*",
              status: "error",
              code: "INVALID_ARGUMENT",
              message,
            },
          ],
        });

        await expect(subPromise).rejects.toThrow(message);
        client.close();
      },
    );

    it("re-anchors a resumed subscription at the last delivered sequence", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          autoReconnect: false,
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        const onEvent = vi.fn();

        const connectPromise = client.connect();
        mockWs.simulateOpen();
        await connectPromise;

        const subPromise = client.subscribe("orders.*", {
          startAfterSequence: 400,
          onEvent,
        });
        mockWs.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        const sub = await subPromise;

        mockWs.simulateMessage({
          type: "event",
          subscriptionId: "sub-1",
          topic: "orders.created",
          data: { orderId: "o-405" },
          meta: { timestamp: "2026-08-27T00:00:00Z", sequence: 405 },
        });
        expect(onEvent).toHaveBeenCalledTimes(1);

        mockWs.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);

        const subscribeMessages = mockWs.send.mock.calls
          .map((call: unknown[]) => JSON.parse(call[0] as string))
          .filter((message: { type: string }) => message.type === "subscribe");
        expect(subscribeMessages).toHaveLength(1);
        expect(subscribeMessages[0].subscription.options).toMatchObject({
          startAfterSequence: 405,
          includeMetadata: true,
        });
        expect(
          subscribeMessages[0].subscription.options.replay,
        ).toBeUndefined();

        mockWs.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-2" },
          ],
        });
        mockWs.simulateMessage({
          type: "event",
          subscriptionId: "sub-2",
          topic: "orders.created",
          data: { orderId: "o-406" },
          meta: { timestamp: "2026-08-27T00:00:01Z", sequence: 406 },
        });
        expect(onEvent).toHaveBeenCalledTimes(2);

        sub.unsubscribe();
        const unsubscribe = JSON.parse(
          assertDefined(mockWs.send.mock.calls.at(-1))[0] as string,
        );
        expect(unsubscribe).toEqual({
          type: "unsubscribe",
          subscriptionId: "sub-2",
        });

        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("unsubscribes a replacement acknowledged after cancellation", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        await client.connect();
        const firstSocket = mockWs;

        const subPromise = client.subscribe("orders.*", {
          startAfterSequence: 400,
          onEvent: vi.fn(),
        });
        firstSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        const sub = await subPromise;

        firstSocket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);
        const secondSocket = mockWs;
        sub.unsubscribe();
        secondSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-2" },
          ],
        });

        expect(
          JSON.parse(assertDefined(secondSocket.send.mock.calls.at(-1))[0]),
        ).toEqual({
          type: "unsubscribe",
          subscriptionId: "sub-2",
        });
        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("serializes a new same-pattern subscribe behind a canceled reconnect", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        await client.connect();
        const firstSocket = mockWs;

        const firstPromise = client.subscribe("orders.*", {
          startAfterSequence: 400,
        });
        firstSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        const first = await firstPromise;

        firstSocket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);
        const secondSocket = mockWs;
        first.unsubscribe();

        const replacementPromise = client.subscribe("orders.*");
        expect(
          secondSocket.send.mock.calls
            .map(([message]) => JSON.parse(message as string))
            .filter((message) => message.type === "subscribe"),
        ).toHaveLength(1);

        secondSocket.simulateMessage({
          type: "subscription_result",
          results: [
            {
              pattern: "orders.*",
              status: "error",
              code: "INVALID_ARGUMENT",
              message: "old reconnect rejected",
            },
          ],
        });
        expect(
          secondSocket.send.mock.calls
            .map(([message]) => JSON.parse(message as string))
            .filter((message) => message.type === "subscribe"),
        ).toHaveLength(2);

        secondSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-3" },
          ],
        });
        await expect(replacementPromise).resolves.toMatchObject({
          id: "sub-3",
        });
        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("removes a subscription after a terminal reconnect rejection", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const onError = vi.fn();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        await client.connect();
        const firstSocket = mockWs;

        const firstPromise = client.subscribe("orders.*", {
          startAfterSequence: 400,
          onError,
        });
        firstSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        await firstPromise;

        firstSocket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);
        const secondSocket = mockWs;
        secondSocket.simulateMessage({
          type: "subscription_result",
          results: [
            {
              pattern: "orders.*",
              status: "error",
              code: "INVALID_ARGUMENT",
              message: "cursor rejected",
            },
          ],
        });
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            code: "RESUBSCRIBE_FAILED",
            retrying: false,
          }),
        );

        const replacement = client.subscribe("orders.*");
        secondSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-3" },
          ],
        });
        await expect(replacement).resolves.toMatchObject({ id: "sub-3" });
        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries when the WebSocket constructor fails during reconnect", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          autoReconnect: false,
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        await client.connect();
        const firstSocket = mockWs;

        const subPromise = client.subscribe("orders.*", {
          startAfterSequence: 400,
        });
        firstSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        await subPromise;

        class ThrowingWebSocket {
          static OPEN = MockWebSocket.OPEN;
          constructor() {
            throw new Error("constructor failed");
          }
        }
        vi.stubGlobal("WebSocket", ThrowingWebSocket);
        firstSocket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);

        class WorkingWebSocket extends MockWebSocket {
          constructor(_url: string) {
            super();
            mockWs = this;
            queueMicrotask(() => this.simulateOpen());
          }
        }
        vi.stubGlobal("WebSocket", WorkingWebSocket);
        await vi.advanceTimersByTimeAsync(1);

        expect(mockWs).not.toBe(firstSocket);
        expect(mockWs.send).toHaveBeenCalledTimes(1);
        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("restores identifying options without replaying the initial window", async () => {
      vi.useFakeTimers();
      try {
        const { createSubscriptionClient } = await importModule();
        const client = createSubscriptionClient({
          serverUrl: "http://localhost:9123",
          autoReconnect: true,
          reconnectDelay: 1,
          maxReconnectDelay: 1,
        });
        await client.connect();
        const firstSocket = mockWs;

        const subPromise = client.subscribe("orders.*", {
          replay: 25,
          includeMetadata: true,
          filter: "data.total > 100",
          namespace: "production",
          consumerGroup: "processors",
          ackMode: "manual",
          backpressure: "block",
          onEvent: () => {},
        });
        firstSocket.simulateMessage({
          type: "subscription_result",
          results: [
            { pattern: "orders.*", status: "ok", subscriptionId: "sub-1" },
          ],
        });
        await subPromise;

        const initial = JSON.parse(
          assertDefined(firstSocket.send.mock.calls[0])[0],
        );
        expect(initial.subscription.options.replay).toBe(25);

        firstSocket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1);

        const reconnect = JSON.parse(
          assertDefined(mockWs.send.mock.calls[0])[0],
        );
        expect(reconnect.subscription.options).toMatchObject({
          includeMetadata: true,
          filter: "data.total > 100",
          namespace: "production",
          consumerGroup: "processors",
          ackMode: "manual",
          backpressure: "block",
        });
        expect(reconnect.subscription.options.replay).toBeUndefined();

        client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects on subscribe failure", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const subPromise = client.subscribe("invalid::**", {
        onEvent: () => {},
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "invalid::**",
            status: "error",
            code: "INVALID_PATTERN",
            message: "Invalid pattern syntax",
          },
        ],
      });

      await expect(subPromise).rejects.toThrow("Invalid pattern syntax");

      client.close();
    });
  });

  // ============================================================================
  // Event Handling Tests
  // ============================================================================

  describe("events", () => {
    it("delivers events to subscription callback", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const events: any[] = [];
      const subPromise = client.subscribe("system.secret.*", {
        onEvent: (event) => events.push(event),
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.secret.*",
            status: "ok",
            subscriptionId: "sub_1",
          },
        ],
      });

      await subPromise;

      // Simulate event
      mockWs.simulateMessage({
        type: "event",
        subscriptionId: "sub_1",
        topic: "system.secret.API_KEY.updated",
        data: { name: "API_KEY", action: "updated", revision: 3 },
      });

      expect(events).toHaveLength(1);
      expect(events[0].topic).toBe("system.secret.API_KEY.updated");
      expect(events[0].data.name).toBe("API_KEY");
      expect(events[0].data.action).toBe("updated");

      client.close();
    });

    it("delivers subscription errors to callback", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const errors: any[] = [];
      const subPromise = client.subscribe("system.run.>", {
        onEvent: () => {},
        onError: (err) => errors.push(err),
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.run.>",
            status: "ok",
            subscriptionId: "sub_1",
          },
        ],
      });

      await subPromise;

      mockWs.simulateMessage({
        type: "subscription_error",
        subscriptionId: "sub_1",
        code: "NATS_DISCONNECT",
        message: "Connection lost",
        retrying: true,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("NATS_DISCONNECT");

      client.close();
    });

    it("delivers global errors to onError callback", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const errors: any[] = [];
      client.onError((err) => errors.push(err));

      mockWs.simulateMessage({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "Server error",
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("INTERNAL_ERROR");

      client.close();
    });
  });

  // ============================================================================
  // Unsubscribe Tests
  // ============================================================================

  describe("unsubscribe", () => {
    it("sends unsubscribe message", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const subPromise = client.subscribe("system.secret.*", {
        onEvent: () => {},
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "system.secret.*",
            status: "ok",
            subscriptionId: "sub_1",
          },
        ],
      });

      const sub = await subPromise;
      sub.unsubscribe();

      // Find the unsubscribe message
      const unsubMsg = mockWs.send.mock.calls
        .map((call: any) => JSON.parse(call[0]))
        .find((msg: any) => msg.type === "unsubscribe");

      expect(unsubMsg).toBeDefined();
      expect(unsubMsg.subscriptionId).toBe("sub_1");

      client.close();
    });
  });

  // ============================================================================
  // Ackable Subscription Tests
  // ============================================================================

  describe("ackable subscriptions", () => {
    it("returns ackable subscription for manual ack mode", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });

      await client.connect();

      const subPromise = client.subscribe("order.*", {
        ackMode: "manual",
        consumerGroup: "processors",
        onEvent: () => {},
      });

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [
          {
            pattern: "order.*",
            status: "ok",
            subscriptionId: "sub_ack_1",
          },
        ],
      });

      const sub = await subPromise;
      expect(sub.id).toBe("sub_ack_1");
      expect("ack" in sub).toBe(true);
      expect("nak" in sub).toBe(true);
      expect("term" in sub).toBe(true);

      // Test ack
      const ackSub = sub as any;
      await ackSub.ack("evt_1");

      const ackMsg = mockWs.send.mock.calls
        .map((call: any) => JSON.parse(call[0]))
        .find((msg: any) => msg.type === "ack" && msg.ackType === "ack");

      expect(ackMsg).toBeDefined();
      expect(ackMsg.eventId).toBe("evt_1");

      // Test nak
      await ackSub.nak("evt_2", 5000);

      const nakMsg = mockWs.send.mock.calls
        .map((call: any) => JSON.parse(call[0]))
        .find((msg: any) => msg.type === "ack" && msg.ackType === "nak");

      expect(nakMsg).toBeDefined();
      expect(nakMsg.eventId).toBe("evt_2");
      expect(nakMsg.redeliverDelay).toBe(5000);

      // Test term
      await ackSub.term("evt_3");

      const termMsg = mockWs.send.mock.calls
        .map((call: any) => JSON.parse(call[0]))
        .find((msg: any) => msg.type === "ack" && msg.ackType === "term");

      expect(termMsg).toBeDefined();
      expect(termMsg.eventId).toBe("evt_3");

      client.close();
    });
  });

  // ============================================================================
  // createSubscriptionClient factory
  // ============================================================================

  describe("joinConsumerGroup", () => {
    it("subscribes with the requested group and manual acknowledgements", async () => {
      const { createSubscriptionClient } = await importModule();
      const client = createSubscriptionClient({ serverUrl: "http://localhost:9123" });
      await client.connect();

      const subPromise = client.joinConsumerGroup("processors", "order.*");
      const sent = JSON.parse(mockWs.send.mock.calls.at(-1)?.[0] as string);
      expect(sent.subscription.options.consumerGroup).toBe("processors");
      expect(sent.subscription.options.ackMode).toBe("manual");

      mockWs.simulateMessage({
        type: "subscription_result",
        results: [{ pattern: "order.*", status: "ok", subscriptionId: "sub-group" }],
      });
      const subscription = await subPromise;
      expect(subscription.id).toBe("sub-group");
      client.close();
    });
  });

  describe("createSubscriptionClient", () => {
    it("creates a client instance", async () => {
      const { createSubscriptionClient, SubscriptionClient } =
        await importModule();
      const client = createSubscriptionClient({
        serverUrl: "http://localhost:9123",
      });
      expect(client).toBeInstanceOf(SubscriptionClient);
      client.close();
    });
  });
});
