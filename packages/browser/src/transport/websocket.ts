/**
 * WebSocket transport implementation
 */

import type {
  ConnectionState,
  SubscribeOptions,
  AckType,
  SubscriptionEvent,
} from "@ironflow/core";
import {
  getWebSocketUrl,
  WSServerMessageSchema,
  calculateBackoff,
  type WSSubscribeRequest,
  type WSUnsubscribeRequest,
  type WSAckRequest,
} from "@ironflow/core";
import type { Transport, TransportCallbacks, TransportOptions } from "./types.js";

/**
 * WebSocket-based transport for subscriptions
 */
export class WebSocketTransport implements Transport {
  private readonly wsUrl: string;
  private readonly options: TransportOptions;
  private callbacks?: TransportCallbacks;
  private ws: WebSocket | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private pendingSubscriptions: Map<string, SubscribeOptions | undefined> = new Map();

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
    if (this._connectionState === "connected") {
      return;
    }

    if (this.paused) {
      return;
    }

    const timeout = this.options.connectionTimeout ?? 10_000;

    return new Promise((resolve, reject) => {
      this._connectionState = "connecting";
      this.callbacks?.onConnectionChange("connecting");

      const timeoutId = setTimeout(() => {
        if (this._connectionState === "connecting") {
          // Close the pending WebSocket
          if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
          }
          this._connectionState = "disconnected";
          this.callbacks?.onConnectionChange("disconnected");
          reject(new Error(`WebSocket connection timeout after ${timeout}ms`));
        }
      }, timeout);

      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
          clearTimeout(timeoutId);
          this._connectionState = "connected";
          this.reconnectAttempt = 0;
          this.callbacks?.onConnectionChange("connected");

          // Re-subscribe all pending subscriptions
          for (const [pattern, options] of this.pendingSubscriptions) {
            this.sendSubscribe(pattern, options);
          }

          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeoutId);
          const wasConnected = this._connectionState === "connected";
          this._connectionState = "disconnected";
          this.callbacks?.onConnectionChange("disconnected");

          if (
            this.options.autoReconnect &&
            !this.paused &&
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
          this.handleMessage(event.data);
        };
      } catch (error) {
        clearTimeout(timeoutId);
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
      ws.close(1000, "Client disconnect");
    }

    this._connectionState = "disconnected";
    this.pendingSubscriptions.clear();
  }

  subscribe(pattern: string, options?: SubscribeOptions): void {
    this.pendingSubscriptions.set(pattern, options);

    if (this._connectionState === "connected") {
      this.sendSubscribe(pattern, options);
    }
  }

  unsubscribe(subscriptionId: string): void {
    // Remove from pending if pattern matches
    // Note: We don't have pattern->id mapping here, so we just send unsubscribe
    if (this._connectionState === "connected" && this.ws) {
      const request: WSUnsubscribeRequest = {
        type: "unsubscribe",
        subscriptionId,
      };
      this.ws.send(JSON.stringify(request));
    }
  }

  async ack(eventId: string, type: AckType, delay?: number): Promise<void> {
    if (this._connectionState !== "connected" || !this.ws) {
      throw new Error("Not connected");
    }

    const request: WSAckRequest = {
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
      this.ws.close(1000, "Paused");
      this.ws = null;
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
            this.callbacks?.onSubscribed(sub.pattern, sub.subscriptionId);
          } else {
            this.callbacks?.onSubscribeFailed(
              sub.pattern,
              new Error(sub.message ?? `Subscription failed: ${sub.code}`)
            );
          }
        }
        break;

      case "event":
        {
          const event: SubscriptionEvent = {
            topic: message.topic,
            data: message.data,
            meta: message.meta,
            eventId: message.eventId,
          };
          this.callbacks?.onEvent(message.subscriptionId, event);
        }
        break;

      case "subscription_error":
        this.callbacks?.onError(message.subscriptionId, {
          subscriptionId: message.subscriptionId,
          code: message.code,
          message: message.message,
          retrying: message.retrying,
        });
        break;

      case "error":
        // Broadcast to all subscriptions
        this.callbacks?.onError("", {
          code: message.code,
          message: message.message,
        });
        break;
    }
  }

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
 * Create a WebSocket transport
 */
export function createWebSocketTransport(
  serverUrl: string,
  options: TransportOptions
): Transport {
  return new WebSocketTransport(serverUrl, options);
}
