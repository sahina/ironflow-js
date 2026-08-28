import { describe, expect, it, vi } from "vitest";
import type {
  AckType,
  ConnectionState,
  SubscribeOptions,
} from "@ironflow/core";
import { SubscriptionManager } from "./subscription.js";
import type {
  Transport,
  TransportCallbacks,
} from "./transport/types.js";

class RecordingTransport implements Transport {
  readonly connectionState: ConnectionState = "connected";
  callbacks?: TransportCallbacks;
  options?: SubscribeOptions;

  async connect(): Promise<void> {}
  disconnect(): void {}
  unsubscribe(): void {}
  pause(): void {}
  resume(): void {}
  async ack(_eventId: string, _type: AckType): Promise<void> {}

  setCallbacks(callbacks: TransportCallbacks): void {
    this.callbacks = callbacks;
  }

  subscribe(pattern: string, options?: SubscribeOptions): void {
    this.options = options;
    queueMicrotask(() => this.callbacks?.onSubscribed(pattern, "sub-1"));
  }
}

describe("SubscriptionManager resume cursor", () => {
  it("passes an explicit zero cursor through to the transport", async () => {
    const transport = new RecordingTransport();
    const manager = new SubscriptionManager(transport, false);

    await manager.subscribe("orders.*", {
      startAfterSequence: 0,
      onEvent: vi.fn(),
    });

    expect(transport.options?.startAfterSequence).toBe(0);
  });
});
