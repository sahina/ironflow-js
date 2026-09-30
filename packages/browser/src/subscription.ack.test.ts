import { describe, expect, it, vi } from "vitest";
import type { AckableSubscription, AckType, ConnectionState, SubscribeOptions } from "@ironflow/core";
import { SubscriptionManager } from "./subscription.js";
import type { Transport, TransportCallbacks } from "./transport/types.js";

class RecordingTransport implements Transport {
  readonly connectionState: ConnectionState = "connected";
  callbacks?: TransportCallbacks;
  ack = vi.fn(async (_eventId: string, _type: AckType, _delay?: number, _subscriptionId?: string) => {});

  async connect(): Promise<void> {}
  disconnect(): void {}
  unsubscribe(): void {}
  pause(): void {}
  resume(): void {}

  setCallbacks(callbacks: TransportCallbacks): void {
    this.callbacks = callbacks;
  }

  subscribe(pattern: string, _options?: SubscribeOptions): void {
    queueMicrotask(() => this.callbacks?.onSubscribed(pattern, "sub-ack-1"));
  }
}

describe("SubscriptionManager ackable subscription", () => {
  it("passes its subscription ID to the transport on ack, nak and term", async () => {
    const transport = new RecordingTransport();
    const manager = new SubscriptionManager(transport, false);

    const sub = await manager.subscribe("orders.*", {
      consumerGroup: "processors",
      ackMode: "manual",
      onEvent: vi.fn(),
    });
    const ackable = sub as AckableSubscription;

    await ackable.ack("evt-1");
    await ackable.nak("evt-2", 250);
    await ackable.term("evt-3");

    expect(transport.ack).toHaveBeenNthCalledWith(1, "evt-1", "ack", undefined, "sub-ack-1");
    expect(transport.ack).toHaveBeenNthCalledWith(2, "evt-2", "nak", 250, "sub-ack-1");
    expect(transport.ack).toHaveBeenNthCalledWith(3, "evt-3", "term", undefined, "sub-ack-1");
  });
});
