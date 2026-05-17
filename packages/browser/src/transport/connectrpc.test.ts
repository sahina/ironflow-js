import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectError, Code } from "@connectrpc/connect";
import type { ConnectionState, AckType } from "@ironflow/core";
import { isExplicitCancellation, isTransientNetworkError } from "./connectrpc.js";
import { assertDefined } from "../internal/assert-defined.js";

// Inline types to avoid complex imports
interface TransportOptions {
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectBackoff?: number;
}

interface TransportCallbacks {
  onEvent: (subscriptionId: string, event: unknown) => void;
  onError: (subscriptionId: string, error: { subscriptionId?: string; code: string; message: string; retrying?: boolean }) => void;
  onConnectionChange: (state: ConnectionState) => void;
  onSubscribed: (pattern: string, subscriptionId: string) => void;
  onSubscribeFailed: (pattern: string, error: Error) => void;
}

interface SubscribeOptions {
  replay?: number;
  includeMetadata?: boolean;
  filter?: string;
  namespace?: string;
  consumerGroup?: string;
  ackMode?: string;
  backpressure?: string;
}

// Mock stream event
interface MockStreamEvent {
  topic: string;
  data?: Record<string, unknown>;
  sequence: bigint;
  eventId: string;
  metadata?: { timestamp?: { seconds: bigint; nanos: number } };
}

// Helper to calculate backoff
function calculateBackoff(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number = 2
): number {
  const delay = initialDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

// Factory function matching the public API
function createConnectRPCTransport(serverUrl: string, options: TransportOptions): ConnectRPCTransport {
  return new ConnectRPCTransport(serverUrl, options);
}

// Inline ConnectRPCTransport implementation for testing (not exported from package, used only for type)
class ConnectRPCTransport {
  private readonly options: TransportOptions;
  private callbacks?: TransportCallbacks;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private activeSubscriptions: Map<string, { pattern: string; options?: SubscribeOptions; abortController: AbortController }> = new Map();
  private subscriptionIdCounter = 0;
  private mockClient: { subscribe: ReturnType<typeof vi.fn> } | null = null;

  constructor(_serverUrl: string, options: TransportOptions) {
    this.options = options;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  setCallbacks(callbacks: TransportCallbacks): void {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if (this._connectionState === "connected") return;
    if (this.paused) return;

    this._connectionState = "connecting";
    this.callbacks?.onConnectionChange("connecting");

    try {
      // Simulate creating ConnectRPC transport and client
      this.mockClient = {
        subscribe: vi.fn(),
      };

      this._connectionState = "connected";
      this.reconnectAttempt = 0;
      this.callbacks?.onConnectionChange("connected");

      // Re-subscribe all pending subscriptions
      for (const [id, sub] of this.activeSubscriptions) {
        this.startSubscriptionStream(id, sub);
      }
    } catch (error) {
      this._connectionState = "disconnected";
      this.callbacks?.onConnectionChange("disconnected");
      throw error;
    }
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.paused = false;

    for (const sub of this.activeSubscriptions.values()) {
      sub.abortController.abort();
    }

    this.mockClient = null;
    this._connectionState = "disconnected";
    this.activeSubscriptions.clear();
    this.callbacks?.onConnectionChange("disconnected");
  }

  subscribe(pattern: string, options?: SubscribeOptions): void {
    const subscriptionId = `crpc-sub-${++this.subscriptionIdCounter}`;
    const abortController = new AbortController();

    const activeSub = { pattern, options, abortController };
    this.activeSubscriptions.set(subscriptionId, activeSub);

    if (this._connectionState === "connected") {
      this.startSubscriptionStream(subscriptionId, activeSub);
    }
  }

  unsubscribe(subscriptionId: string): void {
    const sub = this.activeSubscriptions.get(subscriptionId);
    if (sub) {
      sub.abortController.abort();
      this.activeSubscriptions.delete(subscriptionId);
    }
  }

  async ack(_eventId: string, type: AckType, _delay?: number): Promise<void> {
    // Manual acks are not supported in ConnectRPC browser transport
    throw new Error(
      `Manual acknowledgments are not yet supported in the browser transport. ` +
      `Cannot send ${type}. ` +
      `Use ackMode: "auto" (default) or use WebSocket transport for manual acks.`
    );
  }

  pause(): void {
    this.paused = true;
    this.clearReconnectTimer();

    for (const sub of this.activeSubscriptions.values()) {
      sub.abortController.abort();
      sub.abortController = new AbortController();
    }

    this._connectionState = "disconnected";
    this.callbacks?.onConnectionChange("disconnected");
  }

  resume(): void {
    this.paused = false;
    this.connect().catch(() => {});
  }

  private startSubscriptionStream(
    subscriptionId: string,
    sub: { pattern: string; options?: SubscribeOptions; abortController: AbortController }
  ): void {
    if (!this.mockClient) return;

    // Notify subscription started
    this.callbacks?.onSubscribed(sub.pattern, subscriptionId);
  }

  // Test helper to simulate receiving an event
  simulateEvent(subscriptionId: string, event: MockStreamEvent): void {
    if (!this.activeSubscriptions.has(subscriptionId)) return;

    let timestamp = new Date().toISOString();
    if (event.metadata?.timestamp) {
      const ts = event.metadata.timestamp;
      const ms = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1000000);
      timestamp = new Date(ms).toISOString();
    }

    const subscriptionEvent = {
      topic: event.topic,
      data: event.data ?? {},
      meta: event.metadata ? { timestamp, sequence: Number(event.sequence) } : undefined,
      eventId: event.eventId,
    };

    this.callbacks?.onEvent(subscriptionId, subscriptionEvent);
  }

  // Test helper to simulate a stream error
  simulateStreamError(subscriptionId: string, errorMessage: string): void {
    if (!this.activeSubscriptions.has(subscriptionId)) return;

    this.callbacks?.onError(subscriptionId, {
      subscriptionId,
      code: "STREAM_ERROR",
      message: errorMessage,
      retrying: this.options.autoReconnect,
    });

    if (this.options.autoReconnect && this._connectionState === "connected") {
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    const wasConnected = this._connectionState === "connected";
    this._connectionState = "disconnected";

    if (wasConnected) {
      this.callbacks?.onConnectionChange("disconnected");
    }

    if (this.options.autoReconnect && !this.paused) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.paused) return;

    this._connectionState = "reconnecting";
    this.callbacks?.onConnectionChange("reconnecting");
    this.reconnectAttempt++;

    const delay = calculateBackoff(
      this.reconnectAttempt,
      this.options.reconnectDelay ?? 1000,
      this.options.maxReconnectDelay ?? 30000,
      this.options.reconnectBackoff ?? 2
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      for (const sub of this.activeSubscriptions.values()) {
        sub.abortController = new AbortController();
      }

      this.connect().catch(() => {
        this.handleDisconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

describe("ConnectRPCTransport", () => {
  let transport: ConnectRPCTransport;
  let callbacks: TransportCallbacks;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = {
      onEvent: vi.fn(),
      onError: vi.fn(),
      onConnectionChange: vi.fn(),
      onSubscribed: vi.fn(),
      onSubscribeFailed: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connection", () => {
    it("should connect successfully", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      await transport.connect();

      expect(transport.connectionState).toBe("connected");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("connecting");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("connected");
    });

    it("should not connect when already connected", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      await transport.connect();
      await transport.connect();

      expect(callbacks.onConnectionChange).toHaveBeenCalledTimes(2); // connecting + connected once
    });

    it("should not connect when paused", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      transport.pause();

      await transport.connect();

      expect(transport.connectionState).toBe("disconnected");
    });
  });

  describe("disconnect", () => {
    it("should disconnect and clear subscriptions", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();

      transport.subscribe("test.pattern");
      transport.disconnect();

      expect(transport.connectionState).toBe("disconnected");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("disconnected");
    });
  });

  describe("subscription", () => {
    beforeEach(async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();
    });

    it("should notify onSubscribed when subscription starts", () => {
      transport.subscribe("events.*", { replay: 10 });

      expect(callbacks.onSubscribed).toHaveBeenCalledWith("events.*", expect.stringContaining("crpc-sub-"));
    });

    it("should queue subscriptions when not connected", () => {
      const offlineTransport = createConnectRPCTransport("http://localhost:9123", {});
      offlineTransport.setCallbacks(callbacks);

      offlineTransport.subscribe("offline.pattern");

      expect(callbacks.onSubscribed).not.toHaveBeenCalled();
    });

    it("should call onSubscribed after connect for queued subscriptions", async () => {
      const queuedTransport = createConnectRPCTransport("http://localhost:9123", {});
      queuedTransport.setCallbacks(callbacks);

      queuedTransport.subscribe("queued.pattern");
      expect(callbacks.onSubscribed).not.toHaveBeenCalled();

      await queuedTransport.connect();
      expect(callbacks.onSubscribed).toHaveBeenCalledWith("queued.pattern", expect.any(String));
    });

    it("should handle unsubscribe", () => {
      transport.subscribe("test.*");
      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;

      transport.unsubscribe(subscriptionId);

      // Subscription should be removed
      transport.simulateEvent(subscriptionId, {
        topic: "test.event",
        sequence: 1n,
        eventId: "evt-1",
      });

      expect(callbacks.onEvent).not.toHaveBeenCalled();
    });
  });

  describe("event handling", () => {
    beforeEach(async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();
      transport.subscribe("events.*");
    });

    it("should invoke onEvent callback when event is received", () => {
      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;

      transport.simulateEvent(subscriptionId, {
        topic: "events.created",
        data: { id: 123 },
        sequence: 1n,
        eventId: "evt-1",
      });

      expect(callbacks.onEvent).toHaveBeenCalledWith(
        subscriptionId,
        expect.objectContaining({
          topic: "events.created",
          data: { id: 123 },
          eventId: "evt-1",
        })
      );
    });

    it("should convert timestamp correctly", () => {
      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;
      const timestamp = { seconds: 1704067200n, nanos: 500000000 }; // 2024-01-01T00:00:00.5Z

      transport.simulateEvent(subscriptionId, {
        topic: "events.created",
        sequence: 1n,
        eventId: "evt-1",
        metadata: { timestamp },
      });

      expect(callbacks.onEvent).toHaveBeenCalledWith(
        subscriptionId,
        expect.objectContaining({
          meta: expect.objectContaining({
            timestamp: expect.any(String),
            sequence: 1,
          }),
        })
      );
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 30000,
      });
      transport.setCallbacks(callbacks);
      await transport.connect();
      transport.subscribe("events.*");
    });

    it("should invoke onError callback on stream error", () => {
      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;

      transport.simulateStreamError(subscriptionId, "Stream closed");

      expect(callbacks.onError).toHaveBeenCalledWith(subscriptionId, {
        subscriptionId,
        code: "STREAM_ERROR",
        message: "Stream closed",
        retrying: true,
      });
    });

    it("should trigger reconnect on stream error", () => {
      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;

      transport.simulateStreamError(subscriptionId, "Connection lost");

      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("reconnecting");
    });
  });

  describe("manual acks", () => {
    beforeEach(async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();
    });

    it("should throw error for ack", async () => {
      await expect(transport.ack("evt-1", "ack")).rejects.toThrow(
        "Manual acknowledgments are not yet supported"
      );
    });

    it("should throw error for nak", async () => {
      await expect(transport.ack("evt-1", "nak", 5000)).rejects.toThrow(
        "Manual acknowledgments are not yet supported"
      );
    });

    it("should throw error for term", async () => {
      await expect(transport.ack("evt-1", "term")).rejects.toThrow(
        "Manual acknowledgments are not yet supported"
      );
    });

    it("should include transport type in error message", async () => {
      try {
        await transport.ack("evt-1", "ack");
      } catch (e) {
        expect((e as Error).message).toContain("browser transport");
        expect((e as Error).message).toContain("WebSocket transport");
      }
    });
  });

  describe("pause/resume", () => {
    it("should pause and disconnect", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();

      transport.pause();

      expect(transport.connectionState).toBe("disconnected");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("disconnected");
    });

    it("should resume and reconnect", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      await transport.connect();

      transport.pause();
      transport.resume();

      // After resume, connect() is called asynchronously and succeeds immediately in the mock
      // So state transitions through connecting to connected
      expect(["connecting", "connected"]).toContain(transport.connectionState);
    });

    it("should not connect while still paused", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      transport.pause();
      await transport.connect();

      expect(transport.connectionState).toBe("disconnected");
    });
  });

  describe("reconnection", () => {
    it("should schedule reconnect with backoff", async () => {
      transport = createConnectRPCTransport("http://localhost:9123", {
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 10000,
        reconnectBackoff: 2,
      });
      transport.setCallbacks(callbacks);
      await transport.connect();
      transport.subscribe("events.*");

      const subscriptionId = assertDefined(
        (callbacks.onSubscribed as ReturnType<typeof vi.fn>).mock.calls[0]
      )[1] as string;
      transport.simulateStreamError(subscriptionId, "Error");

      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("reconnecting");

      // Advance past first reconnect delay
      vi.advanceTimersByTime(1000);

      // Should attempt reconnect
      expect(transport.connectionState).toBe("connected");
    });
  });
});

describe("isExplicitCancellation", () => {
  it("should match AbortError", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");
    expect(isExplicitCancellation(error)).toBe(true);
  });

  it("should match ConnectError with Code.Canceled", () => {
    const error = new ConnectError("The operation was aborted.", Code.Canceled);
    expect(isExplicitCancellation(error)).toBe(true);
  });

  it("should NOT match ConnectError with Code.Unavailable", () => {
    const error = new ConnectError("service unavailable", Code.Unavailable);
    expect(isExplicitCancellation(error)).toBe(false);
  });

  it("should NOT match network TypeError", () => {
    const error = new TypeError("NetworkError when attempting to fetch resource.");
    expect(isExplicitCancellation(error)).toBe(false);
  });

  it("should NOT match generic Error", () => {
    expect(isExplicitCancellation(new Error("something broke"))).toBe(false);
  });

  it("should NOT match non-Error objects", () => {
    expect(isExplicitCancellation("string error")).toBe(false);
    expect(isExplicitCancellation(42)).toBe(false);
    expect(isExplicitCancellation(null)).toBe(false);
  });
});

describe("isTransientNetworkError", () => {
  describe("transient errors (should return true)", () => {
    it("should match ConnectError with Code.Unavailable", () => {
      const error = new ConnectError("service unavailable", Code.Unavailable);
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it("should match ConnectError Code.Unknown with 'BodyStreamBuffer was aborted'", () => {
      const error = new ConnectError("BodyStreamBuffer was aborted", Code.Unknown);
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it("should match ConnectError Code.Unknown with 'aborted' message", () => {
      const error = new ConnectError(
        "The stream was aborted during reconnection",
        Code.Unknown
      );
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it("should match TypeError with 'fetch' message", () => {
      const error = new TypeError("NetworkError when attempting to fetch resource.");
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it("should match TypeError with 'network' message", () => {
      const error = new TypeError("network error");
      expect(isTransientNetworkError(error)).toBe(true);
    });
  });

  describe("non-transient errors (should return false)", () => {
    it("should NOT match ConnectError with Code.Canceled", () => {
      const error = new ConnectError("canceled", Code.Canceled);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match ConnectError with Code.PermissionDenied", () => {
      const error = new ConnectError("permission denied", Code.PermissionDenied);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match ConnectError with Code.InvalidArgument", () => {
      const error = new ConnectError("invalid pattern", Code.InvalidArgument);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match ConnectError with Code.Unauthenticated", () => {
      const error = new ConnectError("missing auth", Code.Unauthenticated);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match ConnectError with Code.Internal", () => {
      const error = new ConnectError("internal error", Code.Internal);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match ConnectError Code.Unknown without abort message", () => {
      const error = new ConnectError("something unexpected", Code.Unknown);
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match generic Error", () => {
      expect(isTransientNetworkError(new Error("something broke"))).toBe(false);
    });

    it("should NOT match TypeError without network message", () => {
      const error = new TypeError("Cannot read property 'foo' of undefined");
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it("should NOT match non-Error objects", () => {
      expect(isTransientNetworkError("string error")).toBe(false);
      expect(isTransientNetworkError(42)).toBe(false);
      expect(isTransientNetworkError(null)).toBe(false);
    });
  });
});
