import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionManager } from "./subscription.js";
import { WebSocketTransport } from "./transport/websocket.js";

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

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SubscriptionManager WebSocket reconnect", () => {
  it("delivers resumed events and unsubscribes the replacement subscription", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      autoReconnect: true,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
    });
    const manager = new SubscriptionManager(transport, false);
    const onEvent = vi.fn();

    const subPromise = manager.subscribe("orders.*", {
      startAfterSequence: 400,
      onEvent,
    });
    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    firstSocket!.open();
    await vi.waitFor(() => expect(firstSocket!.send).toHaveBeenCalledTimes(1));
    firstSocket!.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    const sub = await subPromise;

    firstSocket!.message({
      type: "event",
      subscriptionId: "sub-1",
      topic: "orders.created",
      data: { orderId: "o-405" },
      meta: { timestamp: "2026-08-27T00:00:00Z", sequence: 405 },
    });
    expect(onEvent).toHaveBeenCalledTimes(1);

    firstSocket!.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket).toBeDefined();
    secondSocket!.open();
    secondSocket!.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-2" }],
    });
    secondSocket!.message({
      type: "event",
      subscriptionId: "sub-2",
      topic: "orders.created",
      data: { orderId: "o-406" },
      meta: { timestamp: "2026-08-27T00:00:01Z", sequence: 406 },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);

    sub.unsubscribe();
    const lastMessage = secondSocket!.send.mock.calls.at(-1)?.[0];
    expect(JSON.parse(lastMessage as string)).toEqual({
      type: "unsubscribe",
      subscriptionId: "sub-2",
    });

    secondSocket!.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const thirdSocket = MockWebSocket.instances[2];
    expect(thirdSocket).toBeDefined();
    thirdSocket!.open();
    expect(thirdSocket!.send).not.toHaveBeenCalled();
  });

  it("restores every same-pattern consumer-group subscription", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      autoReconnect: true,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
    });
    const manager = new SubscriptionManager(transport, false);
    const onEvent1 = vi.fn();
    const onEvent2 = vi.fn();

    const subPromise1 = manager.subscribe("orders.>", {
      consumerGroup: "workers",
      onEvent: onEvent1,
    });
    const subPromise2 = manager.subscribe("orders.>", {
      consumerGroup: "workers",
      onEvent: onEvent2,
    });
    const firstSocket = MockWebSocket.instances[0]!;
    firstSocket.open();
    await vi.waitFor(() => expect(firstSocket.send).toHaveBeenCalledTimes(2));
    firstSocket.message({
      type: "subscription_result",
      results: [
        { pattern: "orders.>", status: "ok", subscriptionId: "sub-1" },
        { pattern: "orders.>", status: "ok", subscriptionId: "sub-2" },
      ],
    });
    const [sub1, sub2] = await Promise.all([subPromise1, subPromise2]);

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = MockWebSocket.instances[1]!;
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.send).toHaveBeenCalledTimes(2));
    secondSocket.message({
      type: "subscription_result",
      results: [
        { pattern: "orders.>", status: "ok", subscriptionId: "sub-3" },
        { pattern: "orders.>", status: "ok", subscriptionId: "sub-4" },
      ],
    });
    secondSocket.message({
      type: "event",
      subscriptionId: "sub-3",
      topic: "orders.created",
      data: { orderId: "o-1" },
    });
    secondSocket.message({
      type: "event",
      subscriptionId: "sub-4",
      topic: "orders.created",
      data: { orderId: "o-2" },
    });

    expect(onEvent1).toHaveBeenCalledTimes(1);
    expect(onEvent2).toHaveBeenCalledTimes(1);
    expect(sub1.id).toBe("sub-3");
    expect(sub2.id).toBe("sub-4");

    sub1.unsubscribe();
    sub2.unsubscribe();
    expect(
      secondSocket.send.mock.calls
        .slice(-2)
        .map(([message]) => JSON.parse(message)),
    ).toEqual([
      { type: "unsubscribe", subscriptionId: "sub-3" },
      { type: "unsubscribe", subscriptionId: "sub-4" },
    ]);
  });

  it("unsubscribes a replacement acknowledged after the handle was canceled", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      autoReconnect: true,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
    });
    const manager = new SubscriptionManager(transport, false);

    const subPromise = manager.subscribe("orders.*", {
      startAfterSequence: 400,
      onEvent: vi.fn(),
    });
    const firstSocket = MockWebSocket.instances[0]!;
    firstSocket.open();
    await vi.waitFor(() => expect(firstSocket.send).toHaveBeenCalledTimes(1));
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    const sub = await subPromise;

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = MockWebSocket.instances[1]!;
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.send).toHaveBeenCalledTimes(1));

    sub.unsubscribe();
    secondSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-2" }],
    });

    expect(JSON.parse(secondSocket.send.mock.calls.at(-1)![0])).toEqual({
      type: "unsubscribe",
      subscriptionId: "sub-2",
    });
  });

  it("does not reject a new same-pattern handle for a canceled reconnect", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      autoReconnect: true,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
    });
    const manager = new SubscriptionManager(transport, false);

    const firstPromise = manager.subscribe("orders.*", {
      startAfterSequence: 400,
    });
    const firstSocket = MockWebSocket.instances[0]!;
    firstSocket.open();
    await vi.waitFor(() => expect(firstSocket.send).toHaveBeenCalledTimes(1));
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    const first = await firstPromise;

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = MockWebSocket.instances[1]!;
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.send).toHaveBeenCalledTimes(1));
    first.unsubscribe();

    const replacementPromise = manager.subscribe("orders.*", {});
    await vi.waitFor(() =>
      expect(
        secondSocket.send.mock.calls.map(
          ([message]) => JSON.parse(message).type,
        ),
      ).toEqual(["subscribe", "unsubscribe", "subscribe"]),
    );
    secondSocket.message({
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
    secondSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-3" }],
    });

    await expect(replacementPromise).resolves.toMatchObject({ id: "sub-3" });
  });

  it("removes public state after a terminal reconnect rejection", async () => {
    const transport = new WebSocketTransport("http://localhost:9123", {
      autoReconnect: true,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
    });
    const manager = new SubscriptionManager(transport, false);
    const onError = vi.fn();

    const firstPromise = manager.subscribe("orders.*", {
      startAfterSequence: 400,
      onError,
    });
    const firstSocket = MockWebSocket.instances[0]!;
    firstSocket.open();
    await vi.waitFor(() => expect(firstSocket.send).toHaveBeenCalledTimes(1));
    firstSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-1" }],
    });
    await firstPromise;

    firstSocket.close(1006);
    await vi.advanceTimersByTimeAsync(1);
    const secondSocket = MockWebSocket.instances[1]!;
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.send).toHaveBeenCalledTimes(1));
    secondSocket.message({
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
    expect(manager.activeSubscriptionCount).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "RESUBSCRIBE_FAILED",
        retrying: false,
      }),
    );

    const replacement = manager.subscribe("orders.*", {});
    secondSocket.message({
      type: "subscription_result",
      results: [{ pattern: "orders.*", status: "ok", subscriptionId: "sub-3" }],
    });
    await expect(replacement).resolves.toMatchObject({ id: "sub-3" });
  });
});
