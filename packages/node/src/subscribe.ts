/**
 * Node.js SubscriptionClient for real-time event subscriptions via WebSocket.
 *
 * Uses the same WebSocket protocol as the browser SDK but designed for
 * server-side Node.js usage (long-running processes, workers).
 */

import type {
  ConnectionState,
  SubscribeOptions,
  SubscriptionEvent,
  SubscriptionErrorInfo,
  Subscription,
  AckableSubscription,
  AckType,
} from "@ironflow/core";
import {
  getWebSocketUrl,
  WSServerMessageSchema,
  calculateBackoff,
} from "@ironflow/core";
import type {
  WSSubscribeRequest,
  WSUnsubscribeRequest,
  WSAckRequest,
} from "@ironflow/core";

// Re-export patterns for convenience
export { patterns } from "@ironflow/core";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the SubscriptionClient
 */
export interface SubscriptionClientConfig {
  /** Server URL (e.g., "http://localhost:9123"). WebSocket URL is derived automatically. */
  serverUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Environment for environment-scoped subscriptions */
  environment?: string;
  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Reconnect backoff multiplier (default: 1.5) */
  reconnectBackoff?: number;
  /** Connection timeout in ms (default: 10000) */
  connectionTimeout?: number;
}

/**
 * Subscription callbacks for event-driven usage
 */
export interface SubscriptionCallbacks<T = unknown> {
  /** Called when an event is received */
  onEvent?: (event: SubscriptionEvent<T>) => void;
  /** Called when a subscription error occurs */
  onError?: (error: SubscriptionErrorInfo) => void;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
}

// ============================================================================
// Internal state
// ============================================================================

interface PendingSubscription {
  pattern: string;
  options?: SubscribeOptions;
  callbacks: SubscriptionCallbacks;
  resolve: (sub: Subscription | AckableSubscription) => void;
  reject: (error: Error) => void;
}

interface ActiveSubscription {
  id: string;
  pattern: string;
  options?: SubscribeOptions;
  callbacks: SubscriptionCallbacks;
}

// ============================================================================
// SubscriptionClient
// ============================================================================

/**
 * WebSocket-based subscription client for Node.js.
 *
 * Connects to the Ironflow server and provides real-time event subscriptions
 * with auto-reconnect, pattern helpers, and ackable subscriptions.
 *
 * @example
 * ```typescript
 * import { createSubscriptionClient, patterns } from "@ironflow/node";
 *
 * const subClient = createSubscriptionClient({
 *   serverUrl: "http://localhost:9123",
 * });
 *
 * await subClient.connect();
 *
 * const sub = await subClient.subscribe(patterns.allSecrets(), {
 *   onEvent: (event) => {
 *     console.log(`Secret ${event.data.name} was ${event.data.action}`);
 *   },
 * });
 *
 * // Later: clean up
 * sub.unsubscribe();
 * subClient.close();
 * ```
 */
export class SubscriptionClient {
  private readonly config: Required<
    Pick<
      SubscriptionClientConfig,
      | "autoReconnect"
      | "reconnectDelay"
      | "maxReconnectDelay"
      | "reconnectBackoff"
      | "connectionTimeout"
    >
  > &
    SubscriptionClientConfig;
  private readonly wsUrl: string;

  private ws: WebSocket | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // Subscription tracking
  private pending: Map<string, PendingSubscription> = new Map(); // pattern -> pending
  private subscriptions: Map<string, ActiveSubscription> = new Map(); // subId -> active
  private patternToId: Map<string, string> = new Map(); // pattern -> subId

  // Global callbacks
  private connectionCallbacks: Set<(state: ConnectionState) => void> =
    new Set();
  private errorCallbacks: Set<(error: SubscriptionErrorInfo) => void> =
    new Set();

  constructor(config: SubscriptionClientConfig) {
    this.config = {
      autoReconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      reconnectBackoff: 1.5,
      connectionTimeout: 10000,
      ...config,
    };

    // Build WebSocket URL with auth/env params
    const baseWsUrl = getWebSocketUrl(config.serverUrl);
    const params: string[] = [];
    if (config.environment) {
      params.push(`env=${encodeURIComponent(config.environment)}`);
    }
    if (config.apiKey) {
      params.push(`token=${encodeURIComponent(config.apiKey)}`);
    }
    if (params.length > 0) {
      const separator = baseWsUrl.includes("?") ? "&" : "?";
      this.wsUrl = `${baseWsUrl}${separator}${params.join("&")}`;
    } else {
      this.wsUrl = baseWsUrl;
    }
  }

  /** Current connection state */
  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  /** Whether the client is connected */
  get isConnected(): boolean {
    return this._connectionState === "connected";
  }

  /**
   * Connect to the Ironflow server.
   */
  async connect(): Promise<void> {
    if (this._connectionState === "connected") {
      return;
    }
    if (this.closed) {
      throw new Error("Client is closed");
    }

    const timeout = this.config.connectionTimeout;

    return new Promise<void>((resolve, reject) => {
      this._connectionState = "connecting";
      this.notifyConnectionChange("connecting");

      const timeoutId = setTimeout(() => {
        if (this._connectionState === "connecting") {
          if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
          }
          this._connectionState = "disconnected";
          this.notifyConnectionChange("disconnected");
          reject(new Error(`WebSocket connection timeout after ${timeout}ms`));
        }
      }, timeout);

      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
          clearTimeout(timeoutId);
          this._connectionState = "connected";
          this.reconnectAttempt = 0;
          this.notifyConnectionChange("connected");

          // Re-subscribe all active subscriptions on reconnect
          for (const sub of this.subscriptions.values()) {
            this.sendSubscribe(sub.pattern, sub.options);
          }

          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeoutId);
          const wasConnected = this._connectionState === "connected";
          this._connectionState = "disconnected";
          this.notifyConnectionChange("disconnected");

          if (
            this.config.autoReconnect &&
            !this.closed &&
            event.code !== 1000
          ) {
            this.scheduleReconnect();
          }

          if (!wasConnected && this._connectionState === "disconnected") {
            reject(new Error("WebSocket connection failed"));
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeoutId);
          if (this._connectionState === "connecting") {
            reject(new Error("WebSocket connection error"));
          }
        };

        this.ws.onmessage = (event) => {
          const data =
            typeof event.data === "string"
              ? event.data
              : event.data.toString();
          this.handleMessage(data);
        };
      } catch (error) {
        clearTimeout(timeoutId);
        this._connectionState = "disconnected";
        reject(error);
      }
    });
  }

  /**
   * Close the connection and clean up all subscriptions.
   */
  close(): void {
    this.closed = true;
    this.clearReconnectTimer();

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, "Client close");
    }

    // Reject any pending subscriptions
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Client closed"));
    }

    this._connectionState = "disconnected";
    this.pending.clear();
    this.subscriptions.clear();
    this.patternToId.clear();
  }

  /**
   * Subscribe to events matching a pattern.
   *
   * @example
   * ```typescript
   * // Callback-based
   * const sub = await client.subscribe("system.secret.*", {
   *   onEvent: (event) => console.log(event.topic, event.data),
   *   onError: (err) => console.error(err.message),
   * });
   *
   * // With options
   * const sub = await client.subscribe("system.run.>", {
   *   replay: 10,
   *   includeMetadata: true,
   *   onEvent: (event) => console.log(event),
   * });
   *
   * // Ackable subscription
   * const sub = await client.subscribe("order.*", {
   *   ackMode: "manual",
   *   consumerGroup: "processors",
   *   onEvent: (event) => {
   *     processOrder(event);
   *     sub.ack(event.eventId!);
   *   },
   * });
   * ```
   */
  async subscribe<T = unknown>(
    pattern: string,
    callbacksAndOptions: SubscriptionCallbacks<T> & SubscribeOptions = {}
  ): Promise<Subscription | AckableSubscription> {
    if (!this.isConnected) {
      throw new Error("Not connected to server");
    }

    // Check for duplicate
    if (this.patternToId.has(pattern)) {
      throw new Error(`Already subscribed to pattern: ${pattern}`);
    }

    // Extract options from callbacks
    const {
      onEvent,
      onError,
      onStateChange,
      ...options
    } = callbacksAndOptions;

    const callbacks: SubscriptionCallbacks<T> = {
      onEvent,
      onError,
      onStateChange,
    };

    return new Promise<Subscription | AckableSubscription>((resolve, reject) => {
      const pending: PendingSubscription = {
        pattern,
        options: Object.keys(options).length > 0 ? options : undefined,
        callbacks: callbacks as SubscriptionCallbacks,
        resolve: resolve as (sub: Subscription | AckableSubscription) => void,
        reject,
      };

      this.pending.set(pattern, pending);
      this.sendSubscribe(pattern, pending.options);
    });
  }

  /**
   * Register a global connection state change callback.
   * Returns an unsubscribe function.
   */
  onConnectionChange(callback: (state: ConnectionState) => void): () => void {
    this.connectionCallbacks.add(callback);
    return () => this.connectionCallbacks.delete(callback);
  }

  /**
   * Register a global error callback.
   * Returns an unsubscribe function.
   */
  onError(callback: (error: SubscriptionErrorInfo) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private sendSubscribe(pattern: string, options?: SubscribeOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const request: WSSubscribeRequest = {
      type: "subscribe",
      subscription: {
        pattern,
        options: options
          ? {
              replay: options.replay,
              includeMetadata: options.includeMetadata,
              filter: options.filter,
              consumerGroup: options.consumerGroup,
              ackMode: options.ackMode,
              backpressure: options.backpressure,
              namespace: options.namespace,
            }
          : undefined,
      },
    };

    this.ws.send(JSON.stringify(request));
  }

  private sendUnsubscribe(subscriptionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const request: WSUnsubscribeRequest = {
      type: "unsubscribe",
      subscriptionId,
    };

    this.ws.send(JSON.stringify(request));
  }

  private sendAck(eventId: string, ackType: AckType, delay?: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const request: WSAckRequest = {
      type: "ack",
      eventId,
      ackType,
    };

    if (delay !== undefined && ackType === "nak") {
      request.redeliverDelay = delay;
    }

    this.ws.send(JSON.stringify(request));
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const result = WSServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      return;
    }

    const message = result.data;

    switch (message.type) {
      case "subscription_result":
        for (const sub of message.results) {
          if (sub.status === "ok" && sub.subscriptionId) {
            this.handleSubscribed(sub.pattern, sub.subscriptionId);
          } else {
            this.handleSubscribeFailed(
              sub.pattern,
              new Error(sub.message ?? `Subscription failed: ${sub.code}`)
            );
          }
        }
        break;

      case "event": {
        const active = this.subscriptions.get(message.subscriptionId);
        if (active) {
          const event: SubscriptionEvent = {
            topic: message.topic,
            data: message.data,
            meta: message.meta,
            eventId: message.eventId,
          };
          active.callbacks.onEvent?.(event);
        }
        break;
      }

      case "subscription_error": {
        const errorInfo: SubscriptionErrorInfo = {
          subscriptionId: message.subscriptionId,
          code: message.code,
          message: message.message,
          retrying: message.retrying,
        };

        // Call global error handlers
        for (const cb of this.errorCallbacks) {
          cb(errorInfo);
        }

        // Call subscription-specific handler
        const active = this.subscriptions.get(message.subscriptionId);
        active?.callbacks.onError?.(errorInfo);
        break;
      }

      case "error": {
        const errorInfo: SubscriptionErrorInfo = {
          code: message.code,
          message: message.message,
        };
        for (const cb of this.errorCallbacks) {
          cb(errorInfo);
        }
        break;
      }
    }
  }

  private handleSubscribed(pattern: string, subscriptionId: string): void {
    const pending = this.pending.get(pattern);
    if (!pending) {
      return;
    }

    this.pending.delete(pattern);

    // Store as active
    const active: ActiveSubscription = {
      id: subscriptionId,
      pattern,
      options: pending.options,
      callbacks: pending.callbacks,
    };
    this.subscriptions.set(subscriptionId, active);
    this.patternToId.set(pattern, subscriptionId);

    const isManualAck = pending.options?.ackMode === "manual";

    if (isManualAck) {
      const ackableSub: AckableSubscription = {
        id: subscriptionId,
        pattern,
        connectionState: this._connectionState,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
        ack: (eventId: string) => {
          this.sendAck(eventId, "ack");
          return Promise.resolve();
        },
        nak: (eventId: string, delay?: number) => {
          this.sendAck(eventId, "nak", delay);
          return Promise.resolve();
        },
        term: (eventId: string) => {
          this.sendAck(eventId, "term");
          return Promise.resolve();
        },
      };
      pending.resolve(ackableSub);
    } else {
      const sub: Subscription = {
        id: subscriptionId,
        pattern,
        connectionState: this._connectionState,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
      };
      pending.resolve(sub);
    }
  }

  private handleSubscribeFailed(pattern: string, error: Error): void {
    const pending = this.pending.get(pattern);
    if (!pending) {
      return;
    }

    this.pending.delete(pattern);
    pending.reject(error);
  }

  private unsubscribeById(subscriptionId: string): void {
    const active = this.subscriptions.get(subscriptionId);
    if (!active) {
      return;
    }

    this.sendUnsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.patternToId.delete(active.pattern);
  }

  private notifyConnectionChange(state: ConnectionState): void {
    for (const cb of this.connectionCallbacks) {
      cb(state);
    }
    // Notify all active subscriptions
    for (const sub of this.subscriptions.values()) {
      sub.callbacks.onStateChange?.(state);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) {
      return;
    }

    this._connectionState = "reconnecting";
    this.notifyConnectionChange("reconnecting");
    this.reconnectAttempt++;

    const delay = calculateBackoff(
      this.reconnectAttempt,
      this.config.reconnectDelay,
      this.config.maxReconnectDelay,
      this.config.reconnectBackoff
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Will trigger another reconnect via onclose
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

/**
 * Create a new SubscriptionClient.
 *
 * @example
 * ```typescript
 * import { createSubscriptionClient, patterns } from "@ironflow/node";
 *
 * const client = createSubscriptionClient({
 *   serverUrl: "http://localhost:9123",
 * });
 *
 * await client.connect();
 *
 * const sub = await client.subscribe(patterns.allSecrets(), {
 *   onEvent: (event) => console.log(event.data),
 * });
 * ```
 */
export function createSubscriptionClient(
  config: SubscriptionClientConfig
): SubscriptionClient {
  return new SubscriptionClient(config);
}
