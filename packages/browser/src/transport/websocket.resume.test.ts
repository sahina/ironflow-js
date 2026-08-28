import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "./websocket.js";
import type { TransportCallbacks, TransportOptions } from "./types.js";
import { assertDefined } from "../internal/assert-defined.js";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const transportOptions: TransportOptions = {
  autoReconnect: true,
  reconnectDelay: 1,
  maxReconnectDelay: 1,
  reconnectBackoff: 1,
};

const callbacks: TransportCallbacks = {
  onEvent: vi.fn(),
  onError: vi.fn(),
  onConnectionChange: vi.fn(),
  onSubscribed: vi.fn(),
  onSubscribeFailed: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("WebSocketTransport resume cursor", () => {
  it("restores identifying options without replaying the initial window", async () => {
    const transport = new WebSocketTransport(
      "http://localhost:9123",
      transportOptions,
    );
    transport.setCallbacks(callbacks);
    transport.subscribe("orders.*", {
      replay: 25,
      includeMetadata: true,
      filter: "data.total > 100",
      namespace: "production",
      consumerGroup: "processors",
      ackMode: "manual",
      backpressure: "block",
    });

    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    const initial = JSON.parse(
      assertDefined(firstSocket.send.mock.calls[0])[0] as string,
    );
    expect(initial.subscription.options).toMatchObject({
      replay: 25,
      includeMetadata: true,
      filter: "data.total > 100",
      namespace: "production",
      consumerGroup: "processors",
      ackMode: "manual",
      backpressure: "block",
    });
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();

    const reconnect = JSON.parse(
      assertDefined(secondSocket.send.mock.calls[0])[0] as string,
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
  });

  it("preserves replay until the initial cursor request is accepted", async () => {
    const transport = new WebSocketTransport(
      "http://localhost:9123",
      transportOptions,
    );
    transport.setCallbacks(callbacks);
    transport.subscribe("orders.*", {
      replay: 25,
      startAfterSequence: 400,
    });

    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;
    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();

    const reconnect = JSON.parse(
      assertDefined(secondSocket.send.mock.calls[0])[0] as string,
    );
    expect(reconnect.subscription.options).toMatchObject({
      replay: 25,
      startAfterSequence: 400,
    });
  });

  it("sends zero without collapsing it to unset", async () => {
    const transport = new WebSocketTransport(
      "http://localhost:9123",
      transportOptions,
    );
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const socket = assertDefined(MockWebSocket.instances[0]);
    socket.open();
    await connecting;

    transport.subscribe("orders.*", { startAfterSequence: 0 });

    const request = JSON.parse(
      assertDefined(socket.send.mock.calls[0])[0] as string,
    );
    expect(request.subscription.options).toMatchObject({
      startAfterSequence: 0,
      includeMetadata: true,
    });
  });

  it("uses the last delivered sequence when reconnecting", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      ...transportOptions,
      autoReconnect: false,
    });
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    transport.subscribe("orders.*", { startAfterSequence: 400 });
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    firstSocket.message({
      type: "event",
      subscriptionId: "sub-1",
      topic: "orders.created",
      data: { orderId: "o-405" },
      meta: { timestamp: "2026-08-27T00:00:00Z", sequence: 405 },
    });

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();

    const request = JSON.parse(
      assertDefined(secondSocket.send.mock.calls[0])[0] as string,
    );
    expect(request.subscription.options.startAfterSequence).toBe(405);
    expect(request.subscription.options.replay).toBeUndefined();
  });

  it("reconnects from the exact uint64 sequence", async () => {
    const transport = new WebSocketTransport(
      "http://localhost:9123",
      transportOptions,
    );
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    transport.subscribe("orders.*", { startAfterSequence: 400n });
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    firstSocket.message({
      type: "event",
      subscriptionId: "sub-1",
      topic: "orders.created",
      data: { orderId: "o-large" },
      meta: {
        timestamp: "2026-08-27T00:00:00Z",
        sequence: 9_007_199_254_740_996,
        sequenceExact: "9007199254740995",
      },
    });

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();

    expect(assertDefined(secondSocket.send.mock.calls[0])[0]).toContain(
      '"startAfterSequence":9007199254740995',
    );
  });

  it("does not retry a rejected cursor subscription", async () => {
    const transport = new WebSocketTransport(
      "http://localhost:9123",
      transportOptions,
    );
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    transport.subscribe("orders.*", {
      replay: 25,
      startAfterSequence: 400,
    });
    firstSocket.message({
      type: "subscription_result",
      results: [
        {
          pattern: "orders.*",
          status: "error",
          code: "INVALID_ARGUMENT",
          message: "replay and startAfterSequence are mutually exclusive",
        },
      ],
    });
    expect(callbacks.onSubscribeFailed).toHaveBeenCalledTimes(1);

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();
    expect(secondSocket.send).not.toHaveBeenCalled();
  });

  it("stops reconnecting when a canceled cursor reconnect loses its socket", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      ...transportOptions,
      autoReconnect: false,
    });
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    transport.subscribe("orders.*", { startAfterSequence: 400 });
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);

    const secondSocket = assertDefined(MockWebSocket.instances[1]);
    secondSocket.open();
    transport.unsubscribe("sub-1");
    secondSocket.close(1006);
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("retries after a reconnect attempt times out", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      ...transportOptions,
      autoReconnect: false,
      connectionTimeout: 2,
    });
    transport.setCallbacks(callbacks);
    const connecting = transport.connect();
    const firstSocket = assertDefined(MockWebSocket.instances[0]);
    firstSocket.open();
    await connecting;

    transport.subscribe("orders.*", { startAfterSequence: 400 });
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3);
    expect(MockWebSocket.instances).toHaveLength(3);
    const thirdSocket = assertDefined(MockWebSocket.instances[2]);
    thirdSocket.open();
    expect(thirdSocket.send).toHaveBeenCalledTimes(1);
  });
});
