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
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  // Replace global WebSocket with mock
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor() {
      super();
      mockWs = this;
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
        client.subscribe("system.run.>", { onEvent: () => {} })
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
        client.subscribe("system.secret.*", { onEvent: () => {} })
      ).rejects.toThrow("Already subscribed");

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
