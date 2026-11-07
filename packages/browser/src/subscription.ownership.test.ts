import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionEvent } from "@ironflow/core";
import { ironflow } from "./index.js";

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
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

interface SubscribeFrame {
  type: "subscribe";
  subscription: { pattern: string; options?: Record<string, unknown> };
}

function socket(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket opened");
  return ws;
}

function frames(): Array<Record<string, unknown>> {
  return socket().send.mock.calls.map(
    ([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
  );
}

function subscribeFrames(): SubscribeFrame[] {
  return frames().filter((f) => f.type === "subscribe") as unknown as SubscribeFrame[];
}

function unsubscribedIds(): string[] {
  return frames()
    .filter((f) => f.type === "unsubscribe")
    .map((f) => f.subscriptionId as string);
}

function serverSend(message: unknown): void {
  socket().onmessage?.({ data: JSON.stringify(message) });
}

function accept(pattern: string, subscriptionId: string): void {
  serverSend({
    type: "subscription_result",
    results: [{ pattern, status: "ok", subscriptionId }],
  });
}

function deliver(subscriptionId: string, orderId: string): void {
  serverSend({
    type: "event",
    subscriptionId,
    eventId: `evt-${orderId}`,
    topic: "orders.created",
    data: { orderId },
    meta: { timestamp: "2026-11-02T00:00:00Z" },
  });
}

function orderIds(onEvent: ReturnType<typeof vi.fn>): string[] {
  return onEvent.mock.calls.map(
    ([event]) => ((event as SubscriptionEvent).data as { orderId: string }).orderId,
  );
}

async function subscribeAccepted(
  pattern: string,
  subscriptionId: string,
  options: Parameters<typeof ironflow.subscribe>[1],
) {
  const pending = ironflow.subscribe(pattern, options);
  await vi.waitFor(() => expect(subscribeFrames().length).toBeGreaterThan(0));
  accept(pattern, subscriptionId);
  return pending;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  ironflow.configure({
    serverUrl: "http://localhost:9123",
    transport: "websocket",
    logger: false,
    reconnect: { enabled: false },
  });
});

afterEach(() => {
  ironflow.disconnect();
  vi.unstubAllGlobals();
});

describe("broadcast subscription ownership", () => {
  it("gives a confirmed duplicate its own subscription and cleanup", async () => {
    const first = vi.fn();
    const one = await subscribeAccepted("orders.*", "sub-1", { onEvent: first });
    const second = vi.fn();
    const two = await subscribeAccepted("orders.*", "sub-2", { onEvent: second });
    one.unsubscribe();
    deliver("sub-1", "ignored");
    deliver("sub-2", "o-2");
    expect(first).not.toHaveBeenCalled();
    expect(orderIds(second)).toEqual(["o-2"]);
    expect(unsubscribedIds()).toEqual(["sub-1"]);
    two.unsubscribe();
    expect(unsubscribedIds()).toEqual(["sub-1", "sub-2"]);
  });

  it("frees the pattern once its owner unsubscribes", async () => {
    const first = await subscribeAccepted("orders.*", "sub-1", { onEvent: vi.fn() });
    first.unsubscribe();
    expect(unsubscribedIds()).toEqual(["sub-1"]);

    const second = vi.fn();
    const pending = ironflow.subscribe("orders.*", { onEvent: second });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    accept("orders.*", "sub-2");
    await pending;

    deliver("sub-2", "o-2");
    expect(orderIds(second)).toEqual(["o-2"]);
  });

  it.each([
    { replay: 10 }, { startAfterSequence: 400 },
    { filter: "data.total > 100" }, { namespace: "tenant-b" },
    { ackMode: "manual" as const },
  ])("preserves each duplicate's options %j", async (options) => {
    await subscribeAccepted("orders.*", "sub-1", {});
    const pending = ironflow.subscribe("orders.*", options);
    expect(subscribeFrames()).toHaveLength(2);
    expect(subscribeFrames()[1]!.subscription.options).toMatchObject(options);
    accept("orders.*", "sub-2");
    await expect(pending).resolves.toMatchObject({ id: "sub-2" });
  });

  describe("two subscribers racing on one pattern before the server confirms", () => {
    async function race() {
      const first = vi.fn();
      const second = vi.fn();
      let firstOutcome = "pending";
      let firstSub: Awaited<ReturnType<typeof ironflow.subscribe>> | undefined;
      void ironflow.subscribe("orders.*", { onEvent: first }).then(
        (sub) => { firstSub = sub; firstOutcome = "resolved"; },
        () => (firstOutcome = "rejected"),
      );
      const pendingSecond = ironflow.subscribe("orders.*", { onEvent: second, replay: 5 });
      await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
      accept("orders.*", "sub-1");
      accept("orders.*", "sub-2");
      const secondSub = await pendingSecond;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { first, second, secondSub, firstSub: () => firstSub!, firstOutcome: () => firstOutcome };
    }

    it("sends both requests with their own options", async () => {
      await race();
      expect(subscribeFrames().map((f) => f.subscription.options?.replay)).toEqual([
        undefined,
        5,
      ]);
    });

    it("settles both callers with their own subscription", async () => {
      const { secondSub, firstOutcome } = await race();
      expect(firstOutcome()).toBe("resolved");
      expect(secondSub.id).toBe("sub-2");
      expect(ironflow.getActiveSubscriptionCount()).toBe(2);
    });

    it("routes each request's events to its own caller", async () => {
      const { first, second } = await race();
      deliver("sub-1", "o-1");
      deliver("sub-2", "o-2");
      expect(orderIds(second)).toEqual(["o-2"]);
      expect(orderIds(first)).toEqual(["o-1"]);
    });

    it("closes exactly the server subscriptions each caller owns", async () => {
      const { secondSub, firstSub } = await race();
      secondSub.unsubscribe();
      expect(unsubscribedIds()).toEqual(["sub-2"]);
      expect(ironflow.getActiveSubscriptionCount()).toBe(1);
      firstSub().unsubscribe();
      expect(unsubscribedIds()).toEqual(["sub-2", "sub-1"]);
    });
  });

  it("rolls back an array on actual server rejection without closing another handle", async () => {
    await subscribeAccepted("orders.*", "sub-1", { onEvent: vi.fn() });

    const pending = ironflow.subscribe(["payments.*", "orders.*"], { onEvent: vi.fn() });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    accept("payments.*", "sub-2");

    const rejected = expect(pending).rejects.toThrow("denied");
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(3));
    serverSend({ type: "subscription_result", results: [{ pattern: "orders.*", status: "error", message: "denied" }] });
    await rejected;
    expect(unsubscribedIds()).toEqual(["sub-2"]);
    expect(ironflow.getActiveSubscriptionCount()).toBe(1);
  });

  it("allows independent projection subscriptions", async () => {
    const pattern = "system.projection.orders.>";
    const first = ironflow.subscribeToProjection("orders", { onUpdate: vi.fn() });
    const second = ironflow.subscribeToProjection("orders", { onUpdate: vi.fn() });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    accept(pattern, "sub-1");
    accept(pattern, "sub-2");
    const handles = await Promise.all([first, second]);
    handles.forEach((handle) => handle.unsubscribe());
    expect(unsubscribedIds()).toEqual(["sub-1", "sub-2"]);
  });

  it("correlates actual send order when a connected callback overtakes an awaiting call", async () => {
    const firstEvents = vi.fn();
    const callbackEvents = vi.fn();
    let callbackPromise: ReturnType<typeof ironflow.subscribe> | undefined;
    const off = ironflow.onConnectionChange((state) => {
      if (state === "connected") callbackPromise = ironflow.subscribe("orders.*", { replay: 9, onEvent: callbackEvents });
    });
    const first = ironflow.subscribe("orders.*", { replay: 3, onEvent: firstEvents });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    expect(subscribeFrames().map((f) => f.subscription.options?.replay)).toEqual([9, 3]);
    accept("orders.*", "callback");
    accept("orders.*", "awaiting");
    const [one, two] = await Promise.all([first, callbackPromise!]);
    expect([one.id, two.id]).toEqual(["awaiting", "callback"]);
    deliver(one.id, "one"); deliver(two.id, "two");
    expect(orderIds(firstEvents)).toEqual(["one"]);
    expect(orderIds(callbackEvents)).toEqual(["two"]);
    off();
  });

});

it("routes manual acknowledgments to each duplicate handle's subscription", async () => {
  const one = await subscribeAccepted("orders.*", "sub-1", { consumerGroup: "g", ackMode: "manual" });
  const two = await subscribeAccepted("orders.*", "sub-2", { consumerGroup: "g", ackMode: "manual" });
  if (!("ack" in one) || !("ack" in two)) throw new Error("expected ackable handles");
  await one.ack("event-1"); await two.ack("event-2");
  expect(frames().filter((frame) => frame.type === "ack").map((frame) => frame.subscriptionId)).toEqual(["sub-1", "sub-2"]);
});

describe("pending ownership", () => {
  it("isolates a same-pattern failure and retains the surviving request", async () => {
    const first = ironflow.subscribe("orders.*", { replay: 2 });
    const failed = expect(first).rejects.toThrow("denied");
    const second = ironflow.subscribe("orders.*", { replay: 5 });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    serverSend({ type: "subscription_result", results: [{ pattern: "orders.*", status: "error", message: "denied" }] });
    accept("orders.*", "survivor");
    await failed;
    const sub = await second;
    expect(sub.id).toBe("survivor");
    sub.unsubscribe();
    expect(unsubscribedIds()).toEqual(["survivor"]);
  });

  it("settles every pending call on disconnect after requests were sent", async () => {
    const first = ironflow.subscribe("orders.*", {});
    const second = ironflow.subscribe("orders.*", {});
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    ironflow.disconnect();
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("consumer-group subscriptions on one pattern", () => {
  it("allows two members and unsubscribing one leaves the other receiving", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const pendingFirst = ironflow.subscribe("orders.*", { onEvent: first, consumerGroup: "g" });
    const pendingSecond = ironflow.subscribe("orders.*", { onEvent: second, consumerGroup: "g" });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    accept("orders.*", "sub-1");
    accept("orders.*", "sub-2");
    const [firstSub] = await Promise.all([pendingFirst, pendingSecond]);
    deliver("sub-1", "o-1");
    expect(orderIds(first)).toEqual(["o-1"]);

    firstSub.unsubscribe();
    expect(unsubscribedIds()).toEqual(["sub-1"]);

    deliver("sub-1", "o-3");
    deliver("sub-2", "o-2");
    expect(orderIds(first)).toEqual(["o-1"]);
    expect(orderIds(second)).toEqual(["o-2"]);
  });

  it("allows a broadcast subscriber beside a consumer-group member on the same pattern", async () => {
    await subscribeAccepted("orders.*", "sub-1", { onEvent: vi.fn(), consumerGroup: "g" });

    const broadcast = vi.fn();
    const pending = ironflow.subscribe("orders.*", { onEvent: broadcast });
    await vi.waitFor(() => expect(subscribeFrames()).toHaveLength(2));
    accept("orders.*", "sub-2");
    await pending;

    deliver("sub-2", "o-2");
    expect(orderIds(broadcast)).toEqual(["o-2"]);
    expect(ironflow.getActiveSubscriptionCount()).toBe(2);
  });
});
