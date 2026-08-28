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
  advanceResumeCursor,
  createWSSubscribeRequest,
  getWebSocketUrl,
  resumeSequenceFromMetadata,
  serializeWSSubscribeRequest,
  WSServerMessageSchema,
  calculateBackoff,
  subscriptionOptionsForReconnect,
  type WSSubscribeRequest,
  type WSUnsubscribeRequest,
  type WSAckRequest,
} from "@ironflow/core";
import type {
  Transport,
  TransportCallbacks,
  TransportOptions,
} from "./types.js";
import { webSocketProtocols } from "../websocket-auth.js";

interface PendingSubscription {
  options?: SubscribeOptions;
  sent: boolean;
  accepted: boolean;
  subscriptionId?: string;
  awaitingResult: boolean;
  canceled: boolean;
}

/**
 * WebSocket-based transport for subscriptions
 */
export class WebSocketTransport implements Transport {
  private readonly wsUrl: string;
  private readonly protocols: string[];
  private readonly options: TransportOptions;
  private callbacks?: TransportCallbacks;
  private ws: WebSocket | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private pendingSubscriptions: Map<string, PendingSubscription[]> = new Map();
  private subscriptionPatterns: Map<string, string> = new Map();

  constructor(serverUrl: string, options: TransportOptions) {
    const baseWsUrl = getWebSocketUrl(serverUrl);
    const params: string[] = [];

    if (options.environment) {
      params.push(`env=${encodeURIComponent(options.environment)}`);
    }
    if (params.length > 0) {
      const separator = baseWsUrl.includes("?") ? "&" : "?";
      this.wsUrl = `${baseWsUrl}${separator}${params.join("&")}`;
    } else {
      this.wsUrl = baseWsUrl;
    }
    this.protocols = webSocketProtocols(
      options.auth?.apiKey || options.auth?.token,
    );
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
          this.subscriptionPatterns.clear();
          this.discardCanceledSubscriptions();
          this.callbacks?.onConnectionChange("disconnected");
          if (this.shouldReconnect()) {
            this.scheduleReconnect();
          }
          reject(new Error(`WebSocket connection timeout after ${timeout}ms`));
        }
      }, timeout);

      try {
        this.ws = new WebSocket(this.wsUrl, this.protocols);

        this.ws.onopen = () => {
          clearTimeout(timeoutId);
          this._connectionState = "connected";
          this.reconnectAttempt = 0;
          this.callbacks?.onConnectionChange("connected");

          // Re-subscribe all pending subscriptions
          for (const [pattern, subscriptions] of this.pendingSubscriptions) {
            for (const subscription of subscriptions) {
              const options = subscription.accepted
                ? subscriptionOptionsForReconnect(subscription.options)
                : subscription.options;
              if (this.sendSubscribe(pattern, options)) {
                subscription.sent = true;
                subscription.awaitingResult = true;
              }
            }
          }

          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeoutId);
          const wasConnected = this._connectionState === "connected";
          this._connectionState = "disconnected";
          this.subscriptionPatterns.clear();
          this.discardCanceledSubscriptions();
          this.callbacks?.onConnectionChange("disconnected");

          if (
            (this.options.autoReconnect || this.hasCursorSubscription()) &&
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
        this.subscriptionPatterns.clear();
        this.discardCanceledSubscriptions();
        this.callbacks?.onConnectionChange("disconnected");
        if (this.shouldReconnect()) {
          this.scheduleReconnect();
        }
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
    this.subscriptionPatterns.clear();
  }

  subscribe(pattern: string, options?: SubscribeOptions): void {
    const storedOptions = options ? { ...options } : undefined;
    const subscription: PendingSubscription = {
      options: storedOptions,
      sent: false,
      accepted: false,
      awaitingResult: false,
      canceled: false,
    };
    const subscriptions = this.pendingSubscriptions.get(pattern) ?? [];
    subscriptions.push(subscription);
    this.pendingSubscriptions.set(pattern, subscriptions);

    if (this._connectionState === "connected") {
      subscription.sent = this.sendSubscribe(pattern, storedOptions);
      subscription.awaitingResult = subscription.sent;
    }
  }

  unsubscribe(subscriptionId: string): void {
    const pattern =
      this.subscriptionPatterns.get(subscriptionId) ??
      [...this.pendingSubscriptions].find(([, subscriptions]) =>
        subscriptions.some(
          (subscription) => subscription.subscriptionId === subscriptionId,
        ),
      )?.[0];
    if (pattern) {
      const subscriptions = this.pendingSubscriptions.get(pattern);
      const index = subscriptions?.findIndex(
        (subscription) => subscription.subscriptionId === subscriptionId,
      );
      if (subscriptions && index !== undefined && index >= 0) {
        const subscription = subscriptions[index]!;
        if (subscription.awaitingResult) {
          subscription.canceled = true;
        } else {
          subscriptions.splice(index, 1);
          if (subscriptions.length === 0) {
            this.pendingSubscriptions.delete(pattern);
          }
        }
      }
    }
    this.subscriptionPatterns.delete(subscriptionId);

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

  private sendSubscribe(pattern: string, options?: SubscribeOptions): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const request: WSSubscribeRequest = createWSSubscribeRequest(
      pattern,
      options,
    );

    this.ws.send(serializeWSSubscribeRequest(request));
    return true;
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
            const subscriptions = this.pendingSubscriptions.get(sub.pattern);
            const subscription = subscriptions?.find(
              (candidate) => candidate.awaitingResult,
            );
            const previousSubscriptionId = subscription?.subscriptionId;
            if (subscription?.canceled) {
              subscription.awaitingResult = false;
              this.removePendingSubscription(sub.pattern, subscription);
              this.sendUnsubscribe(sub.subscriptionId);
              continue;
            }
            if (subscription) {
              subscription.awaitingResult = false;
              subscription.accepted = true;
              subscription.subscriptionId = sub.subscriptionId;
            }
            if (previousSubscriptionId) {
              this.subscriptionPatterns.delete(previousSubscriptionId);
            }
            this.subscriptionPatterns.set(sub.subscriptionId, sub.pattern);
            if (previousSubscriptionId) {
              this.callbacks?.onSubscribed(
                sub.pattern,
                sub.subscriptionId,
                previousSubscriptionId,
              );
            } else {
              this.callbacks?.onSubscribed(sub.pattern, sub.subscriptionId);
            }
          } else {
            const subscriptions = this.pendingSubscriptions.get(sub.pattern);
            const index = subscriptions?.findIndex(
              (candidate) => candidate.awaitingResult,
            );
            let rejected: PendingSubscription | undefined;
            if (subscriptions && index !== undefined && index >= 0) {
              [rejected] = subscriptions.splice(index, 1);
              if (rejected?.subscriptionId) {
                this.subscriptionPatterns.delete(rejected.subscriptionId);
              }
              if (subscriptions.length === 0) {
                this.pendingSubscriptions.delete(sub.pattern);
              }
              if (rejected?.canceled) {
                continue;
              }
            }
            this.callbacks?.onSubscribeFailed(
              sub.pattern,
              new Error(sub.message ?? `Subscription failed: ${sub.code}`),
              rejected?.subscriptionId,
            );
          }
        }
        break;

      case "event":
        {
          const pattern = this.subscriptionPatterns.get(message.subscriptionId);
          const subscription = pattern
            ? this.pendingSubscriptions
                .get(pattern)
                ?.find(
                  (candidate) =>
                    candidate.subscriptionId === message.subscriptionId,
                )
            : undefined;
          if (subscription) {
            subscription.options = advanceResumeCursor(
              subscription.options,
              resumeSequenceFromMetadata(
                message.meta?.sequence,
                message.meta?.sequenceExact,
              ),
            );
          }
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
      this.options.reconnectBackoff,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        if (this.shouldReconnect()) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private shouldReconnect(): boolean {
    return (
      (this.options.autoReconnect || this.hasCursorSubscription()) &&
      !this.paused
    );
  }

  private hasCursorSubscription(): boolean {
    return [...this.pendingSubscriptions.values()].some((subscriptions) =>
      subscriptions.some(
        (subscription) =>
          subscription.options?.startAfterSequence !== undefined,
      ),
    );
  }

  private removePendingSubscription(
    pattern: string,
    subscription: PendingSubscription,
  ): void {
    const subscriptions = this.pendingSubscriptions.get(pattern);
    const index = subscriptions?.indexOf(subscription) ?? -1;
    if (!subscriptions || index < 0) {
      return;
    }
    subscriptions.splice(index, 1);
    if (subscriptions.length === 0) {
      this.pendingSubscriptions.delete(pattern);
    }
  }

  private discardCanceledSubscriptions(): void {
    for (const [pattern, subscriptions] of this.pendingSubscriptions) {
      const active = subscriptions.filter(
        (subscription) => !subscription.canceled,
      );
      if (active.length === 0) {
        this.pendingSubscriptions.delete(pattern);
      } else if (active.length !== subscriptions.length) {
        this.pendingSubscriptions.set(pattern, active);
      }
    }
  }

  private sendUnsubscribe(subscriptionId: string): void {
    if (this._connectionState !== "connected" || !this.ws) {
      return;
    }
    const request: WSUnsubscribeRequest = {
      type: "unsubscribe",
      subscriptionId,
    };
    this.ws.send(JSON.stringify(request));
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
  options: TransportOptions,
): Transport {
  return new WebSocketTransport(serverUrl, options);
}
