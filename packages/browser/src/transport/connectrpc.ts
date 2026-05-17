/**
 * ConnectRPC transport implementation for browser
 *
 * Uses @connectrpc/connect-web for browser-compatible gRPC communication.
 */

import { createClient, ConnectError, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import type {
  ConnectionState,
  SubscribeOptions as CoreSubscribeOptions,
  AckType,
  SubscriptionEvent,
} from "@ironflow/core";
import { calculateBackoff, HEADERS } from "@ironflow/core";
import { PubSubService } from "@ironflow/core/gen";
import {
  SubscribeRequestSchema,
  SubscribeOptionsSchema,
  AckMode as ProtoAckMode,
  BackpressureMode as ProtoBackpressureMode,
  type SubscriptionEvent as ProtoSubscriptionEvent,
} from "@ironflow/core/gen";

// Type for ConnectRPC client with subscribe method
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PubSubClient = ReturnType<typeof createClient<any>> & {
  subscribe: (
    request: unknown,
    options?: { signal?: AbortSignal }
  ) => AsyncIterable<ProtoSubscriptionEvent>;
};
import type { Transport, TransportCallbacks, TransportOptions } from "./types.js";

/**
 * Active subscription tracking
 */
interface ActiveSubscription {
  pattern: string;
  options?: CoreSubscribeOptions;
  abortController: AbortController;
  subscriptionId?: string;
}

/**
 * Convert SDK ack mode to protobuf enum
 */
function toProtoAckMode(mode?: string): ProtoAckMode {
  switch (mode) {
    case "manual":
      return ProtoAckMode.MANUAL;
    case "auto":
    default:
      return ProtoAckMode.AUTO;
  }
}

/**
 * Convert SDK backpressure mode to protobuf enum
 */
function toProtoBackpressureMode(mode?: string): ProtoBackpressureMode {
  switch (mode) {
    case "drop":
      return ProtoBackpressureMode.DROP;
    case "block":
      return ProtoBackpressureMode.BLOCK;
    case "buffer":
    default:
      return ProtoBackpressureMode.BUFFER;
  }
}

/**
 * Check if a stream error is an explicit user/framework cancellation that
 * should always be suppressed (page unload, React unmount, HMR).
 */
export function isExplicitCancellation(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;

  // Explicit abort via AbortController (unmount, pause, disconnect).
  // DOMException does not extend Error in all environments, so check
  // the name property directly on the object after the null guard.
  if ("name" in error && (error as { name: string }).name === "AbortError")
    return true;

  // ConnectRPC cancellation (page unload, React unmount, HMR)
  if (error instanceof ConnectError && error.code === Code.Canceled)
    return true;

  return false;
}

/**
 * Check if a stream error is a recoverable network/availability issue that
 * should be suppressed when auto-reconnect is enabled. These errors indicate
 * transient problems the transport can recover from automatically.
 *
 * When auto-reconnect is disabled, these errors are surfaced to onError so
 * users can implement their own recovery strategy.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;

  if (error instanceof ConnectError) {
    // Server temporarily unavailable
    if (error.code === Code.Unavailable) return true;
    // Stream aborted mid-reconnection (BodyStreamBuffer was aborted)
    if (
      error.code === Code.Unknown &&
      /aborted|BodyStreamBuffer/i.test(error.message)
    )
      return true;
  }

  // Network-level fetch failures (server not ready, offline)
  if (error instanceof TypeError && /fetch|network/i.test(error.message))
    return true;

  return false;
}

/**
 * ConnectRPC-based transport for browser subscriptions
 *
 * Uses server streaming for auto-ack mode subscriptions.
 */
export class ConnectRPCTransport implements Transport {
  private readonly serverUrl: string;
  private readonly options: TransportOptions;
  private callbacks?: TransportCallbacks;
  private webTransport: ReturnType<typeof createConnectTransport> | null = null;
  private client: PubSubClient | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  // Subscription tracking
  private activeSubscriptions: Map<string, ActiveSubscription> = new Map();
  private subscriptionIdCounter = 0;

  constructor(serverUrl: string, options: TransportOptions) {
    this.serverUrl = serverUrl;
    this.options = options;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  setCallbacks(callbacks: TransportCallbacks): void {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if (this._connectionState === "connected") {
      return;
    }

    if (this.paused) {
      return;
    }

    this._connectionState = "connecting";
    this.callbacks?.onConnectionChange("connecting");

    try {
      // Build interceptors for auth and environment headers
      const envHeader = this.options.environment;
      const auth = this.options.auth;

      const interceptors: Array<(next: (req: any) => Promise<any>) => (req: any) => Promise<any>> = [];

      if (auth?.apiKey || auth?.token) {
        interceptors.push((next) => async (req) => {
          const token = auth.apiKey || auth.token;
          req.header.set("Authorization", `Bearer ${token}`);
          return next(req);
        });
      }

      if (envHeader) {
        interceptors.push((next) => async (req) => {
          req.header.set(HEADERS.ENVIRONMENT, envHeader);
          return next(req);
        });
      }

      // Use Connect transport for streaming (simpler protocol, easier to debug)
      this.webTransport = createConnectTransport({
        baseUrl: this.serverUrl,
        interceptors: interceptors.length > 0 ? interceptors : undefined,
      });

      // Create the PubSub client
      // Type assertion needed due to connect-es v1/v2 type mismatch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client = createClient(PubSubService as any, this.webTransport) as PubSubClient;

      // Mark as connected
      this._connectionState = "connected";
      this.reconnectAttempt = 0;
      this.callbacks?.onConnectionChange("connected");

      // Resubscribe all pending subscriptions
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

    // Abort all active subscriptions
    for (const sub of this.activeSubscriptions.values()) {
      sub.abortController.abort();
    }

    this.webTransport = null;
    this.client = null;
    this._connectionState = "disconnected";
    this.activeSubscriptions.clear();
    this.callbacks?.onConnectionChange("disconnected");
  }

  subscribe(pattern: string, options?: CoreSubscribeOptions): void {
    const subscriptionId = `crpc-sub-${++this.subscriptionIdCounter}`;

    // Create abort controller for this subscription
    const abortController = new AbortController();

    // Track the subscription
    const activeSub: ActiveSubscription = {
      pattern,
      options,
      abortController,
    };

    this.activeSubscriptions.set(subscriptionId, activeSub);

    // Start streaming if connected
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

  async ack(eventId: string, type: AckType, _delay?: number): Promise<void> {
    // Manual acks are not yet supported in the browser transport
    // The server streaming only supports auto-ack mode
    // Bidirectional streaming would be needed for manual acks
    throw new Error(
      `Manual acknowledgments are not yet supported in the browser transport. ` +
        `Cannot send ${type} for event ${eventId}. ` +
        `Use ackMode: "auto" (default) or use WebSocket transport for manual acks.`
    );
  }

  pause(): void {
    this.paused = true;
    this.clearReconnectTimer();

    // Abort all active streams
    for (const sub of this.activeSubscriptions.values()) {
      sub.abortController.abort();
      // Create new abort controller for resume
      sub.abortController = new AbortController();
    }

    this._connectionState = "disconnected";
    this.callbacks?.onConnectionChange("disconnected");
  }

  resume(): void {
    this.paused = false;
    this.connect().catch(() => {
      // Will retry via reconnect logic
    });
  }

  /**
   * Start the subscription stream for a given subscription
   */
  private async startSubscriptionStream(
    subscriptionId: string,
    sub: ActiveSubscription
  ): Promise<void> {
    if (!this.client) return;

    try {
      // Build subscribe request using protobuf create()
      const request = create(SubscribeRequestSchema, {
        pattern: sub.pattern,
        options: create(SubscribeOptionsSchema, {
          replay: sub.options?.replay ?? 0,
          includeMetadata: sub.options?.includeMetadata ?? false,
          filter: sub.options?.filter ?? "",
          namespace: sub.options?.namespace ?? "default",
          consumerGroup: sub.options?.consumerGroup ?? "",
          ackMode: toProtoAckMode(sub.options?.ackMode),
          backpressure: toProtoBackpressureMode(sub.options?.backpressure),
        }),
      });

      // Notify subscription started
      sub.subscriptionId = subscriptionId;
      this.callbacks?.onSubscribed(sub.pattern, subscriptionId);

      // Start server streaming
      const stream = this.client.subscribe(request, {
        signal: sub.abortController.signal,
      });

      // Process events from the stream
      for await (const event of stream) {
        // Check if subscription was cancelled
        if (!this.activeSubscriptions.has(subscriptionId)) {
          break;
        }

        // Convert protobuf event to SDK event
        const subscriptionEvent = this.convertProtoEvent(event);

        // Invoke callback
        this.callbacks?.onEvent(subscriptionId, subscriptionEvent);
      }
    } catch (error) {
      // Explicit cancellations (AbortError, Code.Canceled) are always
      // suppressed — these are user/framework-initiated (unmount, HMR).
      if (isExplicitCancellation(error)) {
        return;
      }

      // Transient network errors (Unavailable, fetch failures, mid-reconnect
      // stream tears) are suppressed only when auto-reconnect is enabled,
      // since the transport handles recovery automatically. When auto-reconnect
      // is off, these fall through to onError so users can react.
      if (isTransientNetworkError(error)) {
        if (
          this.options.autoReconnect &&
          this._connectionState === "connected" &&
          this.activeSubscriptions.has(subscriptionId)
        ) {
          this.handleDisconnect();
          return;
        }
        // autoReconnect is off — fall through to fire onError
      }

      // Check if subscription still exists
      if (!this.activeSubscriptions.has(subscriptionId)) {
        return;
      }

      // Extract error details from ConnectError or standard Error
      let errorMessage = "Unknown error";
      let errorCode = "STREAM_ERROR";

      if (error instanceof ConnectError) {
        errorMessage = error.message;
        errorCode = error.code.toString();
      } else if (error instanceof Error) {
        errorMessage = error.message;
        errorCode = error.name || "STREAM_ERROR";
      } else {
        // Fallback for non-Error objects
        try {
          errorMessage = String(error);
        } catch {
          errorMessage = "Unknown non-Error object";
        }
      }

      // Fire onError only for non-recoverable application errors
      this.callbacks?.onError(subscriptionId, {
        subscriptionId,
        code: errorCode,
        message: errorMessage,
        retrying: this.options.autoReconnect,
      });

      // Trigger reconnect if enabled
      if (this.options.autoReconnect && this._connectionState === "connected") {
        this.handleDisconnect();
      }
    }
  }

  /**
   * Convert protobuf event to SDK event
   */
  private convertProtoEvent(event: ProtoSubscriptionEvent): SubscriptionEvent {
    // Convert timestamp - protobuf Timestamp has seconds and nanos fields
    let timestamp = new Date().toISOString();
    if (event.metadata?.timestamp) {
      const ts = event.metadata.timestamp;
      // Timestamp has seconds (bigint) and nanos (number)
      const ms = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1000000);
      timestamp = new Date(ms).toISOString();
    }

    return {
      topic: event.topic,
      data: (event.data ?? {}) as Record<string, unknown>,
      meta: event.metadata
        ? {
            timestamp,
            sequence: Number(event.sequence),
          }
        : undefined,
      eventId: event.eventId,
    };
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    const wasConnected = this._connectionState === "connected";
    this._connectionState = "disconnected";

    if (wasConnected) {
      this.callbacks?.onConnectionChange("disconnected");
    }

    // Schedule reconnection if enabled
    if (this.options.autoReconnect && !this.paused) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.paused) {
      return;
    }

    this._connectionState = "reconnecting";
    this.callbacks?.onConnectionChange("reconnecting");
    this.reconnectAttempt++;

    const delay = calculateBackoff(
      this.reconnectAttempt,
      this.options.reconnectDelay,
      this.options.maxReconnectDelay,
      this.options.reconnectBackoff
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // Reset abort controllers for reconnect
      for (const sub of this.activeSubscriptions.values()) {
        sub.abortController = new AbortController();
      }

      this.connect().catch(() => {
        // Will trigger another reconnect via handleDisconnect
        this.handleDisconnect();
      });
    }, delay);
  }

  /**
   * Clear the reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * Create a ConnectRPC transport for browser
 */
export function createConnectRPCTransport(
  serverUrl: string,
  options: TransportOptions
): Transport {
  return new ConnectRPCTransport(serverUrl, options);
}
