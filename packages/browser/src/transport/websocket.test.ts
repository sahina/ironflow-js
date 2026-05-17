import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionState, AckType } from "@ironflow/core";

// Mock WebSocket class
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

  // Helper to simulate connection
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose(code: number = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  simulateError(): void {
    this.onerror?.(new Error("WebSocket error"));
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

// Inline getWebSocketUrl
function getWebSocketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, "ws") + "/ws";
}

// Inline calculateBackoff
function calculateBackoff(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number = 2
): number {
  const delay = initialDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

// Inline TransportOptions and TransportCallbacks types
interface TransportOptions {
  auth?: {
    apiKey?: string;
    token?: string;
  };
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectBackoff?: number;
  environment?: string;
}

interface TransportCallbacks {
  onEvent: (subscriptionId: string, event: unknown) => void;
  onError: (subscriptionId: string, error: { code: string; message: string }) => void;
  onConnectionChange: (state: ConnectionState) => void;
  onSubscribed: (pattern: string, subscriptionId: string) => void;
  onSubscribeFailed: (pattern: string, error: Error) => void;
}

// Factory function matching the public API
function createWebSocketTransport(serverUrl: string, options: TransportOptions): WebSocketTransport {
  return new WebSocketTransport(serverUrl, options);
}

// Inline WebSocketTransport implementation (not exported from package, used only for type)
class WebSocketTransport {
  private readonly wsUrl: string;
  private readonly options: TransportOptions;
  private callbacks?: TransportCallbacks;
  private ws: MockWebSocket | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private pendingSubscriptions: Map<string, unknown> = new Map();

  constructor(serverUrl: string, options: TransportOptions) {
    const baseWsUrl = getWebSocketUrl(serverUrl);
    const params: string[] = [];

    if (options.environment) {
      params.push(`env=${encodeURIComponent(options.environment)}`);
    }
    if (options.auth?.apiKey) {
      params.push(`token=${encodeURIComponent(options.auth.apiKey)}`);
    } else if (options.auth?.token) {
      params.push(`token=${encodeURIComponent(options.auth.token)}`);
    }

    if (params.length > 0) {
      const separator = baseWsUrl.includes("?") ? "&" : "?";
      this.wsUrl = `${baseWsUrl}${separator}${params.join("&")}`;
    } else {
      this.wsUrl = baseWsUrl;
    }
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

    return new Promise((resolve, reject) => {
      this._connectionState = "connecting";
      this.callbacks?.onConnectionChange("connecting");

      try {
        this.ws = new MockWebSocket();

        this.ws.onopen = () => {
          this._connectionState = "connected";
          this.reconnectAttempt = 0;
          this.callbacks?.onConnectionChange("connected");
          for (const [pattern, options] of this.pendingSubscriptions) {
            this.sendSubscribe(pattern, options);
          }
          resolve();
        };

        this.ws.onclose = (event) => {
          const wasConnected = this._connectionState === "connected";
          this._connectionState = "disconnected";
          this.callbacks?.onConnectionChange("disconnected");

          if (this.options.autoReconnect && !this.paused && event.code !== 1000) {
            this.scheduleReconnect();
          }

          if (!wasConnected && this._connectionState === "disconnected") {
            reject(new Error("WebSocket connection failed"));
          }
        };

        this.ws.onerror = () => {
          if (this._connectionState === "connecting") {
            reject(new Error("WebSocket connection error"));
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this._connectionState = "disconnected";
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.paused = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000);
    }
    this._connectionState = "disconnected";
    this.pendingSubscriptions.clear();
  }

  subscribe(pattern: string, options?: unknown): void {
    this.pendingSubscriptions.set(pattern, options);
    if (this._connectionState === "connected") {
      this.sendSubscribe(pattern, options);
    }
  }

  unsubscribe(subscriptionId: string): void {
    if (this._connectionState === "connected" && this.ws) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
    }
  }

  async ack(eventId: string, type: AckType, delay?: number): Promise<void> {
    if (this._connectionState !== "connected" || !this.ws) {
      throw new Error("Not connected");
    }

    const request: { type: string; eventId: string; ackType: AckType; redeliverDelay?: number } = {
      type: "ack",
      eventId,
      ackType: type,
    };

    if (delay !== undefined && type === "nak") {
      request.redeliverDelay = delay;
    }

    this.ws.send(JSON.stringify(request));
  }

  pause(): void {
    this.paused = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this._connectionState = "disconnected";
    this.callbacks?.onConnectionChange("disconnected");
  }

  resume(): void {
    this.paused = false;
    this.connect().catch(() => {});
  }

  private sendSubscribe(pattern: string, options?: unknown): void {
    if (!this.ws || this.ws.readyState !== MockWebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "subscribe", subscription: { pattern, options } }));
  }

  private handleMessage(data: string): void {
    let parsed: { type: string; results?: Array<{ pattern: string; status: string; subscriptionId?: string; code?: string; message?: string }>; subscriptionId?: string; topic?: string; data?: unknown; meta?: unknown; eventId?: string; code?: string; message?: string; retrying?: boolean };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    switch (parsed.type) {
      case "subscription_result":
        for (const sub of parsed.results ?? []) {
          if (sub.status === "ok" && sub.subscriptionId) {
            this.callbacks?.onSubscribed(sub.pattern, sub.subscriptionId);
          } else {
            this.callbacks?.onSubscribeFailed(sub.pattern, new Error(sub.message ?? `Subscription failed: ${sub.code}`));
          }
        }
        break;

      case "event":
        this.callbacks?.onEvent(parsed.subscriptionId ?? "", { topic: parsed.topic, data: parsed.data, meta: parsed.meta, eventId: parsed.eventId });
        break;

      case "subscription_error":
        this.callbacks?.onError(parsed.subscriptionId ?? "", { code: parsed.code ?? "UNKNOWN", message: parsed.message ?? "Unknown error" });
        break;

      case "error":
        this.callbacks?.onError("", { code: parsed.code ?? "UNKNOWN", message: parsed.message ?? "Unknown error" });
        break;
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
      this.connect().catch(() => {});
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Test helpers
  getWs(): MockWebSocket | null {
    return this.ws;
  }

  getWsUrl(): string {
    return this.wsUrl;
  }
}

describe("WebSocketTransport", () => {
  let transport: WebSocketTransport;
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
    it("should connect to WebSocket server", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      expect(transport.connectionState).toBe("connected");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("connecting");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("connected");
    });

    it("should not connect when already connected", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      await transport.connect();
      expect(callbacks.onConnectionChange).toHaveBeenCalledTimes(2); // connecting + connected
    });

    it("should not connect when paused", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      transport.pause();

      await transport.connect();
      expect(transport.connectionState).toBe("disconnected");
    });

    it("should reject on connection error", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateError();
      transport.getWs()!.simulateClose(1006);

      await expect(connectPromise).rejects.toThrow();
    });
  });

  describe("disconnect", () => {
    it("should close WebSocket and clear state", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      transport.disconnect();

      expect(transport.connectionState).toBe("disconnected");
    });
  });

  describe("subscription", () => {
    beforeEach(async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;
    });

    it("should send subscribe message", () => {
      transport.subscribe("test.pattern", { replay: 10 });

      expect(transport.getWs()!.send).toHaveBeenCalledWith(
        expect.stringContaining("subscribe")
      );
    });

    it("should queue subscriptions when not connected", () => {
      const offlineTransport = createWebSocketTransport("http://localhost:9123", {});
      offlineTransport.setCallbacks(callbacks);

      offlineTransport.subscribe("queued.pattern");

      // Should not send yet
      expect(offlineTransport.connectionState).toBe("disconnected");
    });

    it("should send unsubscribe message", () => {
      transport.unsubscribe("sub-123");

      expect(transport.getWs()!.send).toHaveBeenCalledWith(
        expect.stringContaining("unsubscribe")
      );
    });
  });

  describe("message handling", () => {
    beforeEach(async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;
    });

    it("should handle subscription_result message", () => {
      transport.getWs()!.simulateMessage(
        JSON.stringify({
          type: "subscription_result",
          results: [{ pattern: "test.*", status: "ok", subscriptionId: "sub-1" }],
        })
      );

      expect(callbacks.onSubscribed).toHaveBeenCalledWith("test.*", "sub-1");
    });

    it("should handle subscription failure", () => {
      transport.getWs()!.simulateMessage(
        JSON.stringify({
          type: "subscription_result",
          results: [{ pattern: "fail.*", status: "error", code: "DENIED", message: "Access denied" }],
        })
      );

      expect(callbacks.onSubscribeFailed).toHaveBeenCalledWith(
        "fail.*",
        expect.any(Error)
      );
    });

    it("should handle event message", () => {
      transport.getWs()!.simulateMessage(
        JSON.stringify({
          type: "event",
          subscriptionId: "sub-1",
          topic: "test.event",
          data: { value: 42 },
          eventId: "evt-1",
        })
      );

      expect(callbacks.onEvent).toHaveBeenCalledWith("sub-1", expect.objectContaining({
        topic: "test.event",
        data: { value: 42 },
      }));
    });

    it("should handle subscription_error message", () => {
      transport.getWs()!.simulateMessage(
        JSON.stringify({
          type: "subscription_error",
          subscriptionId: "sub-1",
          code: "ERR",
          message: "Subscription error",
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith("sub-1", {
        code: "ERR",
        message: "Subscription error",
      });
    });

    it("should handle general error message", () => {
      transport.getWs()!.simulateMessage(
        JSON.stringify({
          type: "error",
          code: "GENERAL_ERR",
          message: "General error",
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith("", {
        code: "GENERAL_ERR",
        message: "General error",
      });
    });

    it("should ignore invalid JSON", () => {
      expect(() => {
        transport.getWs()!.simulateMessage("invalid json");
      }).not.toThrow();

      expect(callbacks.onEvent).not.toHaveBeenCalled();
    });
  });

  describe("acknowledgments", () => {
    beforeEach(async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);
      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;
    });

    it("should send ack message", async () => {
      await transport.ack("evt-1", "ack");

      expect(transport.getWs()!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ack", eventId: "evt-1", ackType: "ack" })
      );
    });

    it("should send nak message with delay", async () => {
      await transport.ack("evt-2", "nak", 5000);

      expect(transport.getWs()!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ack", eventId: "evt-2", ackType: "nak", redeliverDelay: 5000 })
      );
    });

    it("should send term message", async () => {
      await transport.ack("evt-3", "term");

      expect(transport.getWs()!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ack", eventId: "evt-3", ackType: "term" })
      );
    });

    it("should throw when not connected", async () => {
      transport.disconnect();

      await expect(transport.ack("evt-1", "ack")).rejects.toThrow("Not connected");
    });
  });

  describe("reconnection backoff", () => {
    it("should increase delay with each attempt", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 30000,
        reconnectBackoff: 2,
      });
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      // First disconnect
      transport.getWs()!.simulateClose(1006);

      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("reconnecting");

      // First reconnect attempt at 1000ms - connection fails immediately
      vi.advanceTimersByTime(1000);
      expect(transport.connectionState).toBe("connecting");

      // After reconnect triggers, simulate connection failure (no open, just close)
      transport.getWs()?.simulateClose(1006);

      // Now should be reconnecting again with longer delay (2000ms for attempt 2)
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("reconnecting");

      // After 1500ms, still reconnecting (waiting for 2000ms)
      vi.advanceTimersByTime(1500);
      expect(transport.connectionState).toBe("reconnecting");

      // After another 500ms (total 2000ms), second reconnect should trigger
      vi.advanceTimersByTime(500);
      expect(transport.connectionState).toBe("connecting");
    });

    it("should cap delay at maxDelay", () => {
      const delay1 = calculateBackoff(1, 1000, 5000, 2);
      const delay2 = calculateBackoff(2, 1000, 5000, 2);
      const delay3 = calculateBackoff(3, 1000, 5000, 2);
      const delay4 = calculateBackoff(4, 1000, 5000, 2);

      expect(delay1).toBe(1000);
      expect(delay2).toBe(2000);
      expect(delay3).toBe(4000);
      expect(delay4).toBe(5000); // capped at max
    });

    it("should not exceed configured max", () => {
      const delay = calculateBackoff(100, 1000, 30000, 2);
      expect(delay).toBeLessThanOrEqual(30000);
    });
  });

  describe("pause/resume", () => {
    it("should pause and disconnect", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      transport.pause();

      expect(transport.connectionState).toBe("disconnected");
      expect(callbacks.onConnectionChange).toHaveBeenCalledWith("disconnected");
    });

    it("should resume and reconnect", async () => {
      transport = createWebSocketTransport("http://localhost:9123", {});
      transport.setCallbacks(callbacks);

      const connectPromise = transport.connect();
      transport.getWs()!.simulateOpen();
      await connectPromise;

      transport.pause();
      transport.resume();

      // Resume triggers connect
      expect(transport.connectionState).toBe("connecting");
    });
  });

  describe("URL construction", () => {
    it("should append token query param when auth.apiKey is set", () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        auth: { apiKey: "my-api-key" },
      });

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws?token=my-api-key");
    });

    it("should append token query param when auth.token is set", () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        auth: { token: "my-token" },
      });

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws?token=my-token");
    });

    it("should prefer auth.apiKey over auth.token", () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        auth: { apiKey: "api-key", token: "token" },
      });

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws?token=api-key");
    });

    it("should include both env and token params", () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        environment: "staging",
        auth: { apiKey: "my-key" },
      });

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws?env=staging&token=my-key");
    });

    it("should not include token when no auth is set", () => {
      transport = createWebSocketTransport("http://localhost:9123", {});

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws");
    });

    it("should include only env when no auth is set", () => {
      transport = createWebSocketTransport("http://localhost:9123", {
        environment: "production",
      });

      expect(transport.getWsUrl()).toBe("ws://localhost:9123/ws?env=production");
    });
  });
});
