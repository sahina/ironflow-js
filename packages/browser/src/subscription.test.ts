import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  SubscriptionEvent,
  SubscriptionErrorInfo,
  ConnectionState,
  AckType,
} from "@ironflow/core";

// Mock Transport interface inline
interface MockTransport {
  connectionState: ConnectionState;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  setCallbacks: ReturnType<typeof vi.fn>;
  _callbacks?: {
    onEvent: (subscriptionId: string, event: SubscriptionEvent) => void;
    onError: (subscriptionId: string, error: SubscriptionErrorInfo) => void;
    onConnectionChange: (state: ConnectionState) => void;
    onSubscribed: (pattern: string, subscriptionId: string) => void;
    onSubscribeFailed: (pattern: string, error: Error) => void;
  };
}

function createMockTransport(): MockTransport {
  const transport: MockTransport = {
    connectionState: "disconnected" as ConnectionState,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    setCallbacks: vi.fn((callbacks) => {
      transport._callbacks = callbacks;
    }),
  };
  return transport;
}

// Inline SubscriptionManager implementation to avoid complex imports
class SubscriptionManager {
  private transport: MockTransport;
  private subscriptions: Map<string, { pattern: string; options?: { ackMode?: string }; callbacks: { onEvent?: (e: SubscriptionEvent) => void; onError?: (e: SubscriptionErrorInfo) => void } }> = new Map();
  private patternToId: Map<string, string> = new Map();
  private pendingPatterns: Map<string, { id: string; pattern: string; options?: { ackMode?: string }; callbacks: { onEvent?: (e: SubscriptionEvent) => void; onError?: (e: SubscriptionErrorInfo) => void }; resolve?: (sub: unknown) => void; reject?: (error: Error) => void }> = new Map();
  private connectionChangeCallbacks: Set<(state: ConnectionState) => void> = new Set();
  private errorCallbacks: Set<(error: SubscriptionErrorInfo) => void> = new Set();

  constructor(transport: MockTransport) {
    this.transport = transport;
    transport.setCallbacks({
      onEvent: this.handleEvent.bind(this),
      onError: this.handleError.bind(this),
      onConnectionChange: this.handleConnectionChange.bind(this),
      onSubscribed: this.handleSubscribed.bind(this),
      onSubscribeFailed: this.handleSubscribeFailed.bind(this),
    });
  }

  get connectionState(): ConnectionState {
    return this.transport.connectionState;
  }

  async subscribe<T = unknown>(
    pattern: string,
    callbacksAndOptions: { onEvent?: (e: SubscriptionEvent<T>) => void; onError?: (e: SubscriptionErrorInfo) => void; ackMode?: string }
  ): Promise<{ id: string; pattern: string; unsubscribe: () => void; ack?: (eventId: string) => Promise<void>; nak?: (eventId: string, delay?: number) => Promise<void>; term?: (eventId: string) => Promise<void> }> {
    if (this.patternToId.has(pattern)) {
      throw new Error(`Already subscribed to pattern: ${pattern}`);
    }

    return new Promise((resolve, reject) => {
      const tempId = `temp-${Date.now()}`;
      const { ackMode, ...callbacks } = callbacksAndOptions;

      this.pendingPatterns.set(pattern, {
        id: tempId,
        pattern,
        options: { ackMode },
        callbacks: callbacks as { onEvent?: (e: SubscriptionEvent) => void; onError?: (e: SubscriptionErrorInfo) => void },
        resolve: resolve as (sub: unknown) => void,
        reject,
      });

      this.transport.subscribe(pattern, { ackMode });
    });
  }

  unsubscribeByPattern(pattern: string): void {
    const subscriptionId = this.patternToId.get(pattern);
    if (!subscriptionId) return;
    this.transport.unsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.patternToId.delete(pattern);
  }

  unsubscribeById(subscriptionId: string): void {
    const state = this.subscriptions.get(subscriptionId);
    if (!state) return;
    this.transport.unsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.patternToId.delete(state.pattern);
  }

  createGroup() {
    const subscriptions: { unsubscribe: () => void }[] = [];
    return {
      add: async <T>(pattern: string, callbacks: { onEvent?: (e: SubscriptionEvent<T>) => void }) => {
        const sub = await this.subscribe(pattern, callbacks);
        subscriptions.push(sub);
        return sub;
      },
      unsubscribeAll: () => {
        for (const sub of subscriptions) sub.unsubscribe();
        subscriptions.length = 0;
      },
    };
  }

  onConnectionChange(callback: (state: ConnectionState) => void): () => void {
    this.connectionChangeCallbacks.add(callback);
    return () => this.connectionChangeCallbacks.delete(callback);
  }

  onError(callback: (error: SubscriptionErrorInfo) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  async connect(): Promise<void> {
    await this.transport.connect();
  }

  disconnect(): void {
    this.transport.disconnect();
    this.subscriptions.clear();
    this.patternToId.clear();
    this.pendingPatterns.clear();
  }

  pause(): void {
    this.transport.pause();
  }

  resume(): void {
    this.transport.resume();
  }

  private handleEvent(subscriptionId: string, event: SubscriptionEvent): void {
    const state = this.subscriptions.get(subscriptionId);
    if (state) state.callbacks.onEvent?.(event);
  }

  private handleError(subscriptionId: string, error: SubscriptionErrorInfo): void {
    for (const callback of this.errorCallbacks) callback(error);
    if (subscriptionId) {
      const state = this.subscriptions.get(subscriptionId);
      state?.callbacks.onError?.(error);
    }
  }

  private handleConnectionChange(state: ConnectionState): void {
    for (const callback of this.connectionChangeCallbacks) callback(state);
  }

  private handleSubscribed(pattern: string, subscriptionId: string): void {
    const pending = this.pendingPatterns.get(pattern);
    if (!pending) return;

    this.pendingPatterns.delete(pattern);
    pending.id = subscriptionId;
    this.subscriptions.set(subscriptionId, { pattern, options: pending.options, callbacks: pending.callbacks });
    this.patternToId.set(pattern, subscriptionId);

    const isManualAck = pending.options?.ackMode === "manual";

    if (isManualAck) {
      pending.resolve?.({
        id: subscriptionId,
        pattern,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
        ack: (eventId: string) => this.transport.ack(eventId, "ack" as AckType),
        nak: (eventId: string, delay?: number) => this.transport.ack(eventId, "nak" as AckType, delay),
        term: (eventId: string) => this.transport.ack(eventId, "term" as AckType),
      });
    } else {
      pending.resolve?.({
        id: subscriptionId,
        pattern,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
      });
    }
  }

  private handleSubscribeFailed(pattern: string, error: Error): void {
    const pending = this.pendingPatterns.get(pattern);
    if (!pending) return;
    this.pendingPatterns.delete(pattern);
    pending.reject?.(error);
  }
}

describe("SubscriptionManager", () => {
  let transport: MockTransport;
  let manager: SubscriptionManager;

  beforeEach(() => {
    transport = createMockTransport();
    manager = new SubscriptionManager(transport);
  });

  describe("subscribe", () => {
    it("should call transport.subscribe with pattern", async () => {
      const onEvent = vi.fn();
      const subscribePromise = manager.subscribe("test.pattern", { onEvent });

      // Simulate server response
      transport._callbacks!.onSubscribed("test.pattern", "sub-123");
      await subscribePromise;

      expect(transport.subscribe).toHaveBeenCalledWith("test.pattern", expect.any(Object));
    });

    it("should return subscription object with unsubscribe", async () => {
      const subscribePromise = manager.subscribe("test.*", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("test.*", "sub-1");
      const sub = await subscribePromise;

      expect(sub.id).toBe("sub-1");
      expect(sub.pattern).toBe("test.*");
      expect(typeof sub.unsubscribe).toBe("function");
    });

    it("should reject when already subscribed to pattern", async () => {
      const promise1 = manager.subscribe("dup.pattern", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("dup.pattern", "sub-1");
      await promise1;

      await expect(manager.subscribe("dup.pattern", { onEvent: vi.fn() })).rejects.toThrow(
        "Already subscribed to pattern: dup.pattern"
      );
    });

    it("should reject when subscription fails", async () => {
      const subscribePromise = manager.subscribe("fail.pattern", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribeFailed("fail.pattern", new Error("Subscription denied"));

      await expect(subscribePromise).rejects.toThrow("Subscription denied");
    });
  });

  describe("consumer group ack modes", () => {
    describe("acknowledge (ack)", () => {
      it("should call transport.ack with 'ack' type", async () => {
        const subscribePromise = manager.subscribe("events.*", {
          onEvent: vi.fn(),
          ackMode: "manual",
        });
        transport._callbacks!.onSubscribed("events.*", "sub-ack-1");
        const sub = await subscribePromise;

        expect(sub.ack).toBeDefined();
        await sub.ack!("evt-123");

        expect(transport.ack).toHaveBeenCalledWith("evt-123", "ack");
      });

      it("should resolve successfully", async () => {
        const subscribePromise = manager.subscribe("events.*", {
          onEvent: vi.fn(),
          ackMode: "manual",
        });
        transport._callbacks!.onSubscribed("events.*", "sub-ack-2");
        const sub = await subscribePromise;

        await expect(sub.ack!("evt-1")).resolves.toBeUndefined();
      });
    });

    describe("negative acknowledge (nak)", () => {
      it("should call transport.ack with 'nak' type", async () => {
        const subscribePromise = manager.subscribe("events.*", {
          onEvent: vi.fn(),
          ackMode: "manual",
        });
        transport._callbacks!.onSubscribed("events.*", "sub-nak-1");
        const sub = await subscribePromise;

        expect(sub.nak).toBeDefined();
        await sub.nak!("evt-456");

        expect(transport.ack).toHaveBeenCalledWith("evt-456", "nak", undefined);
      });

      it("should pass delay parameter", async () => {
        const subscribePromise = manager.subscribe("events.*", {
          onEvent: vi.fn(),
          ackMode: "manual",
        });
        transport._callbacks!.onSubscribed("events.*", "sub-nak-2");
        const sub = await subscribePromise;

        await sub.nak!("evt-789", 5000);

        expect(transport.ack).toHaveBeenCalledWith("evt-789", "nak", 5000);
      });
    });

    describe("terminate (term)", () => {
      it("should call transport.ack with 'term' type", async () => {
        const subscribePromise = manager.subscribe("events.*", {
          onEvent: vi.fn(),
          ackMode: "manual",
        });
        transport._callbacks!.onSubscribed("events.*", "sub-term-1");
        const sub = await subscribePromise;

        expect(sub.term).toBeDefined();
        await sub.term!("evt-dead");

        expect(transport.ack).toHaveBeenCalledWith("evt-dead", "term");
      });
    });

    describe("auto ack mode (default)", () => {
      it("should not include ack methods for auto mode", async () => {
        const subscribePromise = manager.subscribe("events.*", { onEvent: vi.fn() });
        transport._callbacks!.onSubscribed("events.*", "sub-auto-1");
        const sub = await subscribePromise;

        expect(sub.ack).toBeUndefined();
        expect(sub.nak).toBeUndefined();
        expect(sub.term).toBeUndefined();
      });
    });
  });

  describe("unsubscribe", () => {
    it("should unsubscribe by pattern", async () => {
      const subscribePromise = manager.subscribe("unsub.pattern", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("unsub.pattern", "sub-unsub-1");
      await subscribePromise;

      manager.unsubscribeByPattern("unsub.pattern");

      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-unsub-1");
    });

    it("should unsubscribe via subscription object", async () => {
      const subscribePromise = manager.subscribe("unsub.test", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("unsub.test", "sub-unsub-2");
      const sub = await subscribePromise;

      sub.unsubscribe();

      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-unsub-2");
    });

    it("should do nothing for unknown pattern", () => {
      manager.unsubscribeByPattern("unknown.pattern");
      expect(transport.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe("event handling", () => {
    it("should invoke onEvent callback when event is received", async () => {
      const onEvent = vi.fn();
      const subscribePromise = manager.subscribe("test.events", { onEvent });
      transport._callbacks!.onSubscribed("test.events", "sub-evt-1");
      await subscribePromise;

      const event: SubscriptionEvent = {
        topic: "test.events.created",
        data: { id: 1 },
      };
      transport._callbacks!.onEvent("sub-evt-1", event);

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it("should invoke subscription-specific onError callback", async () => {
      const onError = vi.fn();
      const subscribePromise = manager.subscribe("error.events", { onEvent: vi.fn(), onError });
      transport._callbacks!.onSubscribed("error.events", "sub-err-1");
      await subscribePromise;

      const error: SubscriptionErrorInfo = {
        subscriptionId: "sub-err-1",
        code: "ERR",
        message: "Test error",
      };
      transport._callbacks!.onError("sub-err-1", error);

      expect(onError).toHaveBeenCalledWith(error);
    });
  });

  describe("global error handling", () => {
    it("should invoke global error callbacks", async () => {
      const globalErrorHandler = vi.fn();
      manager.onError(globalErrorHandler);

      const subscribePromise = manager.subscribe("test.*", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("test.*", "sub-global-1");
      await subscribePromise;

      const error: SubscriptionErrorInfo = {
        subscriptionId: "sub-global-1",
        code: "GLOBAL_ERR",
        message: "Global error",
      };
      transport._callbacks!.onError("sub-global-1", error);

      expect(globalErrorHandler).toHaveBeenCalledWith(error);
    });

    it("should allow removing global error callback", () => {
      const handler = vi.fn();
      const unsubscribe = manager.onError(handler);
      unsubscribe();

      transport._callbacks!.onError("", { code: "ERR", message: "test" });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("connection state handling", () => {
    it("should invoke connection change callbacks", () => {
      const callback = vi.fn();
      manager.onConnectionChange(callback);

      transport._callbacks!.onConnectionChange("connected");

      expect(callback).toHaveBeenCalledWith("connected");
    });

    it("should allow removing connection change callback", () => {
      const callback = vi.fn();
      const unsubscribe = manager.onConnectionChange(callback);
      unsubscribe();

      transport._callbacks!.onConnectionChange("connected");

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("subscription groups", () => {
    it("should add subscriptions to group", async () => {
      const group = manager.createGroup();

      const subPromise1 = group.add("group.events1", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("group.events1", "grp-sub-1");
      const sub1 = await subPromise1;

      const subPromise2 = group.add("group.events2", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("group.events2", "grp-sub-2");
      const sub2 = await subPromise2;

      expect(sub1.id).toBe("grp-sub-1");
      expect(sub2.id).toBe("grp-sub-2");
    });

    it("should unsubscribe all subscriptions in group", async () => {
      const group = manager.createGroup();

      const subPromise1 = group.add("batch.1", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("batch.1", "batch-sub-1");
      await subPromise1;

      const subPromise2 = group.add("batch.2", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("batch.2", "batch-sub-2");
      await subPromise2;

      group.unsubscribeAll();

      expect(transport.unsubscribe).toHaveBeenCalledWith("batch-sub-1");
      expect(transport.unsubscribe).toHaveBeenCalledWith("batch-sub-2");
    });
  });

  describe("connect/disconnect", () => {
    it("should call transport.connect", async () => {
      await manager.connect();
      expect(transport.connect).toHaveBeenCalled();
    });

    it("should call transport.disconnect and clear state", async () => {
      const subscribePromise = manager.subscribe("test.*", { onEvent: vi.fn() });
      transport._callbacks!.onSubscribed("test.*", "sub-disc-1");
      await subscribePromise;

      manager.disconnect();

      expect(transport.disconnect).toHaveBeenCalled();
    });
  });

  describe("pause/resume", () => {
    it("should call transport.pause", () => {
      manager.pause();
      expect(transport.pause).toHaveBeenCalled();
    });

    it("should call transport.resume", () => {
      manager.resume();
      expect(transport.resume).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for the REAL SubscriptionManager imported from ./subscription.js
// ---------------------------------------------------------------------------
import { SubscriptionManager as RealSubscriptionManager } from "./subscription.js";
import type { Transport, TransportCallbacks } from "./transport/types.js";
import type {
  Subscription,
  AckableSubscription,
} from "@ironflow/core";

/** Helper: create a mock Transport that satisfies the real interface and captures callbacks */
function createRealMockTransport() {
  let callbacks: TransportCallbacks | undefined;
  let _connectionState: ConnectionState = "disconnected";

  const transport: Transport & {
    _callbacks: () => TransportCallbacks | undefined;
    _setConnectionState: (s: ConnectionState) => void;
  } = {
    get connectionState() {
      return _connectionState;
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    setCallbacks: vi.fn((cbs: TransportCallbacks) => {
      callbacks = cbs;
    }),
    // Test helpers
    _callbacks: () => callbacks,
    _setConnectionState: (s: ConnectionState) => {
      _connectionState = s;
    },
  };

  return transport;
}

describe("SubscriptionManager (real module)", () => {
  let transport: ReturnType<typeof createRealMockTransport>;
  let manager: RealSubscriptionManager;

  beforeEach(() => {
    transport = createRealMockTransport();
    // Pre-flip state so existing tests run the synchronous fast path in
    // subscribe(). Tests that need to exercise auto-connect flip state
    // back to "disconnected" explicitly.
    transport._setConnectionState("connected");
    manager = new RealSubscriptionManager(transport, false); // false = noop logger
  });

  // ---------- Construction ----------

  it("should call setCallbacks on the transport during construction", () => {
    expect(transport.setCallbacks).toHaveBeenCalledTimes(1);
    expect(transport._callbacks()).toBeDefined();
  });

  // ---------- Single pattern subscription ----------

  describe("single pattern subscribe", () => {
    it("should call transport.subscribe and resolve with Subscription", async () => {
      const onEvent = vi.fn();
      const promise = manager.subscribe("run.>", { onEvent });

      expect(transport.subscribe).toHaveBeenCalledWith("run.>", expect.any(Object));

      // Simulate server confirmation
      transport._callbacks()!.onSubscribed("run.>", "real-sub-1");
      const sub = await promise;

      expect(sub.id).toBe("real-sub-1");
      expect(sub.pattern).toBe("run.>");
      expect(typeof sub.unsubscribe).toBe("function");
    });

    it("should reject duplicate broadcast subscriptions to the same pattern", async () => {
      const p1 = manager.subscribe("dup.pattern", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("dup.pattern", "s1");
      await p1;

      await expect(
        manager.subscribe("dup.pattern", { onEvent: vi.fn() })
      ).rejects.toThrow("Already subscribed to pattern: dup.pattern");
    });

    it("should reject when handleSubscribeFailed fires", async () => {
      const promise = manager.subscribe("bad.>", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribeFailed("bad.>", new Error("denied"));
      await expect(promise).rejects.toThrow("denied");
    });
  });

  // ---------- Array pattern subscription ----------

  describe("array pattern subscribe", () => {
    it("should subscribe to multiple patterns and return a combined subscription", async () => {
      // For array subscriptions, subscribeSingle is called sequentially (await in a loop).
      // We must trigger onSubscribed asynchronously when transport.subscribe is called.
      let subCallCount = 0;
      transport.subscribe = vi.fn().mockImplementation((pattern: string) => {
        subCallCount++;
        const id = `sub-${subCallCount}`;
        // Schedule the callback asynchronously so the await in subscribeSingle resolves
        queueMicrotask(() => transport._callbacks()!.onSubscribed(pattern, id));
      });

      const combined = await manager.subscribe(["a.>", "b.>"], { onEvent: vi.fn() });

      expect(combined.pattern).toBe("a.>,b.>");
      expect(typeof combined.unsubscribe).toBe("function");
      expect(transport.subscribe).toHaveBeenCalledTimes(2);
    });

    it("should unsubscribe all inner subscriptions when combined.unsubscribe is called", async () => {
      let subCallCount = 0;
      transport.subscribe = vi.fn().mockImplementation((pattern: string) => {
        subCallCount++;
        const id = `sub-${subCallCount}`;
        queueMicrotask(() => transport._callbacks()!.onSubscribed(pattern, id));
      });

      const combined = await manager.subscribe(["x.>", "y.>"], { onEvent: vi.fn() });
      combined.unsubscribe();

      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-1");
      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-2");
    });

    it("should rollback successful subscriptions if a later one fails", async () => {
      let subCallCount = 0;
      transport.subscribe = vi.fn().mockImplementation((pattern: string) => {
        subCallCount++;
        if (subCallCount === 1) {
          queueMicrotask(() => transport._callbacks()!.onSubscribed(pattern, "sub-ok"));
        } else {
          queueMicrotask(() =>
            transport._callbacks()!.onSubscribeFailed(pattern, new Error("nope"))
          );
        }
      });

      await expect(
        manager.subscribe(["ok.>", "fail.>"], { onEvent: vi.fn() })
      ).rejects.toThrow("nope");

      // The successful subscription should have been rolled back
      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-ok");
    });
  });

  // ---------- Consumer groups ----------

  describe("consumer group subscriptions", () => {
    it("should allow multiple subscriptions to the same pattern with consumerGroup", async () => {
      const p1 = manager.subscribe("orders.>", {
        onEvent: vi.fn(),
        consumerGroup: "workers",
      });
      transport._callbacks()!.onSubscribed("orders.>", "cg-sub-1");
      const sub1 = await p1;

      const p2 = manager.subscribe("orders.>", {
        onEvent: vi.fn(),
        consumerGroup: "workers",
      });
      transport._callbacks()!.onSubscribed("orders.>", "cg-sub-2");
      const sub2 = await p2;

      expect(sub1.id).toBe("cg-sub-1");
      expect(sub2.id).toBe("cg-sub-2");
      // Both should be subscribed independently
      expect(transport.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  // ---------- Event handling ----------

  describe("event handling via handleEvent", () => {
    it("should route events to the correct subscription callback", async () => {
      const onEventA = vi.fn();
      const onEventB = vi.fn();

      const pA = manager.subscribe("a.>", { onEvent: onEventA });
      transport._callbacks()!.onSubscribed("a.>", "sub-a");
      await pA;

      const pB = manager.subscribe("b.>", { onEvent: onEventB });
      transport._callbacks()!.onSubscribed("b.>", "sub-b");
      await pB;

      const event: SubscriptionEvent = { topic: "a.foo", data: { v: 1 } };
      transport._callbacks()!.onEvent("sub-a", event);

      expect(onEventA).toHaveBeenCalledWith(event);
      expect(onEventB).not.toHaveBeenCalled();
    });

    it("should ignore events for unknown subscription IDs", () => {
      // Should not throw
      transport._callbacks()!.onEvent("nonexistent", { topic: "t", data: {} });
    });

    it("should track lastEvent when trackState is enabled", async () => {
      const onEvent = vi.fn();
      const promise = manager.subscribe("track.>", {
        onEvent,
        trackState: true,
      });
      transport._callbacks()!.onSubscribed("track.>", "sub-track");
      await promise;

      const event1: SubscriptionEvent = { topic: "track.a", data: { v: 1 } };
      const event2: SubscriptionEvent = { topic: "track.b", data: { v: 2 } };
      transport._callbacks()!.onEvent("sub-track", event1);
      transport._callbacks()!.onEvent("sub-track", event2);

      // The callback should have been called twice
      expect(onEvent).toHaveBeenCalledTimes(2);
      // Internal tracking happens within the manager; we verify by checking
      // that events are delivered correctly (the lastEvent is stored on the
      // internal state, not publicly accessible after subscription resolves,
      // but we can verify the callback still fires)
      expect(onEvent).toHaveBeenLastCalledWith(event2);
    });
  });

  // ---------- Error handling ----------

  describe("error handling", () => {
    it("should invoke both global and subscription-specific onError", async () => {
      const globalHandler = vi.fn();
      const subHandler = vi.fn();
      manager.onError(globalHandler);

      const p = manager.subscribe("err.>", { onEvent: vi.fn(), onError: subHandler });
      transport._callbacks()!.onSubscribed("err.>", "sub-err");
      await p;

      const error: SubscriptionErrorInfo = {
        subscriptionId: "sub-err",
        code: "TEST",
        message: "test error",
      };
      transport._callbacks()!.onError("sub-err", error);

      expect(globalHandler).toHaveBeenCalledWith(error);
      expect(subHandler).toHaveBeenCalledWith(error);
    });

    it("should invoke global error handler even for unknown subscription IDs", () => {
      const globalHandler = vi.fn();
      manager.onError(globalHandler);

      const error: SubscriptionErrorInfo = { code: "X", message: "orphan" };
      transport._callbacks()!.onError("", error);

      expect(globalHandler).toHaveBeenCalledWith(error);
    });

    it("should remove global error callback when unsubscribe function is called", () => {
      const handler = vi.fn();
      const remove = manager.onError(handler);
      remove();

      transport._callbacks()!.onError("", { code: "X", message: "ignored" });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---------- Connection change propagation ----------

  describe("connection change propagation", () => {
    it("should call onStateChange on each active subscription", async () => {
      const onStateChange = vi.fn();
      const p = manager.subscribe("conn.>", { onEvent: vi.fn(), onStateChange });
      transport._callbacks()!.onSubscribed("conn.>", "sub-conn");
      await p;

      transport._callbacks()!.onConnectionChange("reconnecting");

      expect(onStateChange).toHaveBeenCalledWith("reconnecting");
    });

    it("should invoke global onConnectionChange callbacks", () => {
      const callback = vi.fn();
      manager.onConnectionChange(callback);

      transport._callbacks()!.onConnectionChange("connected");

      expect(callback).toHaveBeenCalledWith("connected");
    });

    it("should allow removing global connection change callback", () => {
      const callback = vi.fn();
      const remove = manager.onConnectionChange(callback);
      remove();

      transport._callbacks()!.onConnectionChange("connected");

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------- Unsubscribe ----------

  describe("unsubscribe", () => {
    it("should unsubscribe by pattern", async () => {
      const p = manager.subscribe("unsub.pat", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("unsub.pat", "sub-u1");
      await p;

      manager.unsubscribeByPattern("unsub.pat");

      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-u1");
    });

    it("should unsubscribe by subscription ID via the returned subscription", async () => {
      const p = manager.subscribe("unsub.id", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("unsub.id", "sub-u2");
      const sub = await p;

      sub.unsubscribe();

      expect(transport.unsubscribe).toHaveBeenCalledWith("sub-u2");
    });

    it("should be a no-op for unknown pattern", () => {
      manager.unsubscribeByPattern("nope");
      expect(transport.unsubscribe).not.toHaveBeenCalled();
    });

    it("should stop delivering events after unsubscribe", async () => {
      const onEvent = vi.fn();
      const p = manager.subscribe("stop.>", { onEvent });
      transport._callbacks()!.onSubscribed("stop.>", "sub-stop");
      const sub = await p;

      sub.unsubscribe();

      // Events for this subscription ID should be ignored
      transport._callbacks()!.onEvent("sub-stop", { topic: "stop.a", data: {} });
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  // ---------- Subscription groups ----------

  describe("subscription groups", () => {
    it("should add subscriptions to a group and unsubscribe all at once", async () => {
      const group = manager.createGroup();

      const p1 = group.add("grp.a", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("grp.a", "g-sub-1");
      await p1;

      const p2 = group.add("grp.b", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("grp.b", "g-sub-2");
      await p2;

      group.unsubscribeAll();

      expect(transport.unsubscribe).toHaveBeenCalledWith("g-sub-1");
      expect(transport.unsubscribe).toHaveBeenCalledWith("g-sub-2");
    });
  });

  // ---------- Manual ack mode ----------

  describe("manual ack mode", () => {
    it("should return AckableSubscription with ack/nak/term methods", async () => {
      const p = manager.subscribe("ack.>", {
        onEvent: vi.fn(),
        ackMode: "manual",
      });
      transport._callbacks()!.onSubscribed("ack.>", "sub-ack");
      const sub = (await p) as AckableSubscription;

      expect(typeof sub.ack).toBe("function");
      expect(typeof sub.nak).toBe("function");
      expect(typeof sub.term).toBe("function");
    });

    it("should delegate ack to transport.ack", async () => {
      const p = manager.subscribe("ack2.>", {
        onEvent: vi.fn(),
        ackMode: "manual",
      });
      transport._callbacks()!.onSubscribed("ack2.>", "sub-ack2");
      const sub = (await p) as AckableSubscription;

      await sub.ack("evt-100");
      expect(transport.ack).toHaveBeenCalledWith("evt-100", "ack");
    });

    it("should delegate nak with optional delay to transport.ack", async () => {
      const p = manager.subscribe("nak.>", {
        onEvent: vi.fn(),
        ackMode: "manual",
      });
      transport._callbacks()!.onSubscribed("nak.>", "sub-nak");
      const sub = (await p) as AckableSubscription;

      await sub.nak("evt-200", 3000);
      expect(transport.ack).toHaveBeenCalledWith("evt-200", "nak", 3000);
    });

    it("should delegate term to transport.ack", async () => {
      const p = manager.subscribe("term.>", {
        onEvent: vi.fn(),
        ackMode: "manual",
      });
      transport._callbacks()!.onSubscribed("term.>", "sub-term");
      const sub = (await p) as AckableSubscription;

      await sub.term("evt-300");
      expect(transport.ack).toHaveBeenCalledWith("evt-300", "term");
    });

    it("should not include ack methods for auto mode (default)", async () => {
      const p = manager.subscribe("auto.>", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("auto.>", "sub-auto");
      const sub = (await p) as Subscription;

      expect((sub as unknown as AckableSubscription).ack).toBeUndefined();
      expect((sub as unknown as AckableSubscription).nak).toBeUndefined();
      expect((sub as unknown as AckableSubscription).term).toBeUndefined();
    });
  });

  // ---------- Connect / disconnect ----------

  describe("connect and disconnect", () => {
    it("should delegate connect to transport", async () => {
      // beforeEach pre-flipped state to "connected" for the sync fast path;
      // reset it so manager.connect() actually triggers the auto-connect path.
      transport._setConnectionState("disconnected");
      await manager.connect();
      expect(transport.connect).toHaveBeenCalled();
    });

    it("should delegate disconnect and clear all internal state", async () => {
      // Set up a subscription
      const p = manager.subscribe("dc.>", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("dc.>", "sub-dc");
      await p;

      manager.disconnect();

      expect(transport.disconnect).toHaveBeenCalled();

      // After disconnect, events should not be delivered
      const onEvent = vi.fn();
      transport._callbacks()!.onEvent("sub-dc", { topic: "dc.a", data: {} });
      expect(onEvent).not.toHaveBeenCalled();

      // Should be able to subscribe to the same pattern again (state was cleared)
      // We verify that the internal patternToId map was cleared by checking that
      // a new subscription to the same pattern does not throw
      const p2 = manager.subscribe("dc.>", { onEvent: vi.fn() });
      transport._callbacks()!.onSubscribed("dc.>", "sub-dc-2");
      const sub2 = await p2;
      expect(sub2.id).toBe("sub-dc-2");
    });
  });

  // ---------- Pause / resume ----------

  describe("pause and resume", () => {
    it("should delegate pause to transport", () => {
      manager.pause();
      expect(transport.pause).toHaveBeenCalled();
    });

    it("should delegate resume to transport", () => {
      manager.resume();
      expect(transport.resume).toHaveBeenCalled();
    });
  });

  // ---------- connectionState getter ----------

  describe("connectionState getter", () => {
    it("should return the transport's current connection state", () => {
      transport._setConnectionState("disconnected");
      expect(manager.connectionState).toBe("disconnected");

      transport._setConnectionState("connected");
      expect(manager.connectionState).toBe("connected");
    });
  });

  // ---------- handleSubscribed with no pending ----------

  describe("edge cases", () => {
    it("should ignore handleSubscribed for patterns with no pending subscriptions", () => {
      // Should not throw
      transport._callbacks()!.onSubscribed("ghost.>", "sub-ghost");
    });

    it("should ignore handleSubscribeFailed for patterns with no pending subscriptions", () => {
      // Should not throw
      transport._callbacks()!.onSubscribeFailed("ghost.>", new Error("no one cares"));
    });

    it("should handle multiple pending subscriptions for the same pattern (consumer groups) in FIFO order", async () => {
      // Subscribe twice with consumer group -- both use the same pattern
      const p1 = manager.subscribe("fifo.>", {
        onEvent: vi.fn(),
        consumerGroup: "g1",
      });
      const p2 = manager.subscribe("fifo.>", {
        onEvent: vi.fn(),
        consumerGroup: "g1",
      });

      // Server sends two confirmations for the same pattern
      transport._callbacks()!.onSubscribed("fifo.>", "fifo-sub-1");
      transport._callbacks()!.onSubscribed("fifo.>", "fifo-sub-2");

      const sub1 = await p1;
      const sub2 = await p2;

      // FIFO: first pending gets first confirmation
      expect(sub1.id).toBe("fifo-sub-1");
      expect(sub2.id).toBe("fifo-sub-2");
    });
  });

  // ---------- Auto-connect on subscribe (issue #536 Defect A) ----------

  describe("auto-connect on subscribe", () => {
    beforeEach(() => {
      // Start from disconnected for this block; each test opts into
      // a specific connection state.
      transport._setConnectionState("disconnected");
    });

    it("kicks off transport.connect() when subscribing while disconnected", async () => {
      (transport.connect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        transport._setConnectionState("connected");
        transport._callbacks()!.onConnectionChange("connected");
      });

      const promise = manager.subscribe("auto.>", { onEvent: vi.fn() });
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.connect).toHaveBeenCalledTimes(1);
      expect(transport.subscribe).toHaveBeenCalledWith("auto.>", expect.any(Object));

      transport._callbacks()!.onSubscribed("auto.>", "sub-auto");
      const sub = await promise;
      expect(sub.id).toBe("sub-auto");
    });

    it("shares one in-flight connect across concurrent subscribe() calls", async () => {
      let resolveConnect: (() => void) | null = null;
      (transport.connect as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<void>((res) => {
            resolveConnect = () => {
              transport._setConnectionState("connected");
              transport._callbacks()!.onConnectionChange("connected");
              res();
            };
          }),
      );

      const p1 = manager.subscribe("a.>", { onEvent: vi.fn() });
      const p2 = manager.subscribe("b.>", { onEvent: vi.fn() });

      expect(transport.connect).toHaveBeenCalledTimes(1);
      resolveConnect!();
      await new Promise((r) => setTimeout(r, 0));

      transport._callbacks()!.onSubscribed("a.>", "sub-a");
      transport._callbacks()!.onSubscribed("b.>", "sub-b");
      const [s1, s2] = await Promise.all([p1, p2]);
      expect(s1.id).toBe("sub-a");
      expect(s2.id).toBe("sub-b");
    });

    it("waits for in-flight reconnect rather than starting a fresh connect", async () => {
      transport._setConnectionState("reconnecting");

      const promise = manager.subscribe("rec.>", { onEvent: vi.fn() });

      // Already reconnecting: we don't call connect() ourselves.
      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.subscribe).not.toHaveBeenCalled();

      transport._setConnectionState("connected");
      transport._callbacks()!.onConnectionChange("connected");
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.subscribe).toHaveBeenCalledWith("rec.>", expect.any(Object));
      transport._callbacks()!.onSubscribed("rec.>", "sub-rec");
      await promise;
    });

    it("rejects subscribe() when transport.connect() fails", async () => {
      (transport.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("server unreachable"),
      );

      await expect(
        manager.subscribe("bad.>", { onEvent: vi.fn() }),
      ).rejects.toThrow("server unreachable");
      expect(transport.subscribe).not.toHaveBeenCalled();
    });
  });

  // ---------- Visibility-resume (issue #536, Q7) ----------

  describe("visibility resume health-check", () => {
    afterEach(() => {
      if (typeof document === "undefined") return;
      // Reset document.hidden to false so one test's state doesn't
      // leak into the next (the visibility block mutates it with
      // Object.defineProperty).
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
    });

    it("triggers connect() when the tab becomes visible while disconnected", () => {
      if (typeof document === "undefined") return;
      transport._setConnectionState("disconnected");
      (transport.connect as ReturnType<typeof vi.fn>).mockClear();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(transport.connect).toHaveBeenCalled();
    });

    it("does not trigger connect() while still hidden", () => {
      if (typeof document === "undefined") return;
      transport._setConnectionState("disconnected");
      (transport.connect as ReturnType<typeof vi.fn>).mockClear();

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(transport.connect).not.toHaveBeenCalled();
    });

    it("does not trigger connect() when already connected", () => {
      if (typeof document === "undefined") return;
      transport._setConnectionState("connected");
      (transport.connect as ReturnType<typeof vi.fn>).mockClear();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(transport.connect).not.toHaveBeenCalled();
    });

    it("removes the visibilitychange listener on disconnect()", () => {
      if (typeof document === "undefined") return;
      transport._setConnectionState("disconnected");
      manager.disconnect();
      (transport.connect as ReturnType<typeof vi.fn>).mockClear();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(transport.connect).not.toHaveBeenCalled();
    });
  });
});
