/**
 * Transport layer type definitions
 */

import type {
  SubscriptionEvent,
  SubscriptionErrorInfo,
  ConnectionState,
  SubscribeOptions,
  AckType,
} from "@ironflow/core";

/**
 * Transport callbacks
 */
export interface TransportCallbacks {
  /** Called when an event is received */
  onEvent: (subscriptionId: string, event: SubscriptionEvent) => void;
  /** Called when a subscription error occurs */
  onError: (subscriptionId: string, error: SubscriptionErrorInfo) => void;
  /** Called when connection state changes */
  onConnectionChange: (state: ConnectionState) => void;
  /** Called when a subscription is confirmed */
  onSubscribed: (pattern: string, subscriptionId: string) => void;
  /** Called when a subscription fails */
  onSubscribeFailed: (pattern: string, error: Error) => void;
}

/**
 * Transport interface for subscription connections
 */
export interface Transport {
  /** Current connection state */
  readonly connectionState: ConnectionState;

  /** Connect to the server */
  connect(): Promise<void>;

  /** Disconnect from the server */
  disconnect(): void;

  /** Subscribe to a pattern */
  subscribe(pattern: string, options?: SubscribeOptions): void;

  /** Unsubscribe from a subscription */
  unsubscribe(subscriptionId: string): void;

  /** Send acknowledgment for an event */
  ack(eventId: string, type: AckType, delay?: number): Promise<void>;

  /** Set callbacks */
  setCallbacks(callbacks: TransportCallbacks): void;

  /** Pause the connection (for tab visibility) */
  pause(): void;

  /** Resume the connection */
  resume(): void;
}

/**
 * Transport factory function type
 */
export type TransportFactory = (
  serverUrl: string,
  options: TransportOptions
) => Transport;

/**
 * Transport options
 */
export interface TransportOptions {
  /** Authentication headers */
  auth?: {
    apiKey?: string;
    token?: string;
  };
  /** Auto-reconnect enabled */
  autoReconnect: boolean;
  /** Initial reconnect delay */
  reconnectDelay: number;
  /** Max reconnect delay */
  maxReconnectDelay: number;
  /** Reconnect backoff multiplier */
  reconnectBackoff: number;
  /** Target environment for environment isolation */
  environment?: string;
  /** Connection timeout in milliseconds (default: 10000) */
  connectionTimeout?: number;
}
