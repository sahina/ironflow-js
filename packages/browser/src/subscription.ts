/**
 * Subscription management for browser client
 */

import type {
  SubscriptionEvent,
  SubscriptionErrorInfo,
  ConnectionState,
  SubscribeOptions,
  Subscription,
  AckableSubscription,
  SubscriptionCallbacks,
  Logger,
} from "@ironflow/core";
import { generateId, createNoopLogger } from "@ironflow/core";
import type { Transport, TransportCallbacks } from "./transport/types.js";

/**
 * Extended subscription options for the browser client
 */
export interface BrowserSubscribeOptions extends SubscribeOptions {
  /** Track last event for state access */
  trackState?: boolean;
}

/**
 * Internal subscription state
 */
interface SubscriptionState<T = unknown> {
  id: string;
  pattern: string;
  /** Unique key for map lookups (pattern for broadcast, pattern + ID for consumer groups) */
  lookupKey: string;
  options?: BrowserSubscribeOptions;
  callbacks: SubscriptionCallbacks<T>;
  connectionState: ConnectionState;
  lastEvent?: SubscriptionEvent<T>;
  resolve?: (sub: Subscription | AckableSubscription) => void;
  reject?: (error: Error) => void;
}

/**
 * Subscription group for batch management
 */
export interface SubscriptionGroup {
  /** Add a subscription to the group */
  add<T = unknown>(
    pattern: string,
    callbacks: SubscriptionCallbacks<T> & BrowserSubscribeOptions
  ): Promise<Subscription | AckableSubscription>;
  /** Unsubscribe all subscriptions in the group */
  unsubscribeAll(): void;
}

/**
 * Default auto-connect timeout (ms) used by subscribe() when the transport is
 * not yet connected. 10s matches the transport's default connection timeout.
 */
const DEFAULT_AUTO_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Subscription manager handles all active subscriptions
 */
export class SubscriptionManager {
  private transport: Transport;
  // Logger is stored for future use (debugging, diagnostics)
  private _logger: Logger;
  private subscriptions: Map<string, SubscriptionState> = new Map();
  private patternToId: Map<string, string> = new Map();
  private pendingPatterns: Map<string, SubscriptionState> = new Map();
  /** Maps pattern to array of pending lookupKeys for O(1) lookup */
  private patternToPendingKeys: Map<string, string[]> = new Map();
  private connectionChangeCallbacks: Set<(state: ConnectionState) => void> = new Set();
  private errorCallbacks: Set<(error: SubscriptionErrorInfo) => void> = new Set();
  /** Shared in-flight connect promise so concurrent subscribe() calls don't double-connect. */
  private connectPromise: Promise<void> | null = null;
  /** Wired in constructor; removed in disconnect(). SSR-guarded. */
  private visibilityListener: (() => void) | null = null;
  private readonly autoConnectTimeoutMs: number;

  /**
   * Count of currently active (non-pending) subscriptions. Surfaced via
   * `ironflow.getActiveSubscriptionCount()` for leak audits and
   * diagnostics.
   */
  public get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  constructor(transport: Transport, logger?: Logger | false) {
    this.transport = transport;
    this._logger = logger === false ? createNoopLogger() : (logger ?? createNoopLogger());
    this._logger.debug("SubscriptionManager initialized");
    this.autoConnectTimeoutMs = DEFAULT_AUTO_CONNECT_TIMEOUT_MS;

    // Set up transport callbacks
    const callbacks: TransportCallbacks = {
      onEvent: this.handleEvent.bind(this),
      onError: this.handleError.bind(this),
      onConnectionChange: this.handleConnectionChange.bind(this),
      onSubscribed: this.handleSubscribed.bind(this),
      onSubscribeFailed: this.handleSubscribeFailed.bind(this),
    };
    this.transport.setCallbacks(callbacks);

    // Wire Page Visibility API: on return to foreground, if the transport has
    // silently died (mobile Safari / long-backgrounded tab), trigger a
    // reconnect health-check instead of waiting for the next user interaction.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const listener = () => {
        if (document.hidden) {
          return;
        }
        const state = this.transport.connectionState;
        if (state !== "connected" && state !== "connecting") {
          this.ensureConnected().catch(() => {
            // Best-effort; transport's own reconnect loop continues.
          });
        }
      };
      document.addEventListener("visibilitychange", listener);
      this.visibilityListener = listener;
    }
  }

  /**
   * Subscribe to events matching a pattern
   */
  async subscribe<T = unknown>(
    pattern: string | string[],
    callbacksAndOptions: SubscriptionCallbacks<T> & BrowserSubscribeOptions
  ): Promise<Subscription | AckableSubscription> {
    // Handle array of patterns
    if (Array.isArray(pattern)) {
      const subscriptions: Subscription[] = [];

      try {
        for (const p of pattern) {
          const sub = await this.subscribeSingle<T>(p, callbacksAndOptions);
          subscriptions.push(sub);
        }
      } catch (error) {
        // Rollback successful subscriptions on failure
        for (const sub of subscriptions) {
          sub.unsubscribe();
        }
        throw error;
      }

      // Return a combined subscription
      const combinedPattern = pattern.join(",");
      const combinedId = generateId();
      const combinedSub: Subscription = {
        id: combinedId,
        pattern: combinedPattern,
        connectionState: this.transport.connectionState,
        unsubscribe: () => {
          for (const sub of subscriptions) {
            sub.unsubscribe();
          }
        },
      };

      return combinedSub;
    }

    return this.subscribeSingle<T>(pattern, callbacksAndOptions);
  }

  private async subscribeSingle<T = unknown>(
    pattern: string,
    callbacksAndOptions: SubscriptionCallbacks<T> & BrowserSubscribeOptions
  ): Promise<Subscription | AckableSubscription> {
    // Extract options and callbacks
    const {
      replay,
      includeMetadata,
      filter,
      namespace,
      consumerGroup,
      ackMode,
      backpressure,
      trackState,
      ...callbacks
    } = callbacksAndOptions;

    const options: BrowserSubscribeOptions = {
      replay,
      includeMetadata,
      filter,
      namespace,
      consumerGroup,
      ackMode,
      backpressure,
      trackState,
    };

    // Generate lookup key: for consumer groups, allow multiple subscriptions to same pattern
    // by appending a unique ID; for broadcast, use pattern directly to prevent duplicates
    const lookupKey = consumerGroup
      ? `${pattern}:cg:${generateId()}`
      : pattern;

    // Check if already subscribed (only for broadcast subscriptions)
    if (!consumerGroup && this.patternToId.has(lookupKey)) {
      throw new Error(`Already subscribed to pattern: ${pattern}`);
    }

    return new Promise<Subscription | AckableSubscription>((resolve, reject) => {
      const tempId = generateId();

      const pending: SubscriptionState<T> = {
        id: tempId,
        pattern,
        lookupKey,
        options,
        callbacks: callbacks as SubscriptionCallbacks<unknown>,
        connectionState: this.transport.connectionState,
        resolve: resolve as (sub: Subscription | AckableSubscription) => void,
        reject,
      };

      this.pendingPatterns.set(lookupKey, pending as SubscriptionState);

      // Track lookupKey by pattern for efficient lookup when server responds
      const pendingKeys = this.patternToPendingKeys.get(pattern) ?? [];
      pendingKeys.push(lookupKey);
      this.patternToPendingKeys.set(pattern, pendingKeys);

      // Auto-connect: callers shouldn't need to call connect() before
      // subscribe(). When already connected, we call transport.subscribe
      // synchronously (fast path — matches pre-#536 behavior). Otherwise we
      // await connect and then subscribe, rejecting the promise if connect
      // fails or times out. Fixes #536 Defect A, where watch()/subscribe()
      // would hang forever waiting on a connect nobody kicked off.
      if (this.transport.connectionState === "connected") {
        this.transport.subscribe(pattern, options);
        return;
      }

      this.ensureConnected().then(
        () => {
          // Guard against disconnect() racing with connect: disconnect()
          // clears pendingPatterns, so if ours is gone, settle the outer
          // promise with a clear rejection instead of hanging — hanging
          // forever is the exact class of bug this PR fixes.
          if (!this.pendingPatterns.has(lookupKey)) {
            reject(new Error("ironflow: subscription canceled before connect completed"));
            return;
          }
          this.transport.subscribe(pattern, options);
        },
        (err) => {
          this.removePending(pattern, lookupKey);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Remove a pending subscription entry from both tracking maps. */
  private removePending(pattern: string, lookupKey: string): void {
    this.pendingPatterns.delete(lookupKey);
    const keys = this.patternToPendingKeys.get(pattern);
    if (!keys) return;
    const idx = keys.indexOf(lookupKey);
    if (idx >= 0) keys.splice(idx, 1);
    if (keys.length === 0) this.patternToPendingKeys.delete(pattern);
  }

  /**
   * Unsubscribe by pattern
   */
  unsubscribeByPattern(pattern: string): void {
    const subscriptionId = this.patternToId.get(pattern);
    if (!subscriptionId) {
      return;
    }

    this.transport.unsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.patternToId.delete(pattern);
  }

  /**
   * Unsubscribe by subscription ID
   */
  unsubscribeById(subscriptionId: string): void {
    const state = this.subscriptions.get(subscriptionId);
    if (!state) {
      return;
    }

    this.transport.unsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.patternToId.delete(state.lookupKey);
  }

  /**
   * Create a subscription group for batch management
   */
  createGroup(): SubscriptionGroup {
    const subscriptions: Subscription[] = [];

    return {
      add: async <T = unknown>(
        pattern: string,
        callbacks: SubscriptionCallbacks<T> & BrowserSubscribeOptions
      ) => {
        const sub = await this.subscribe<T>(pattern, callbacks);
        subscriptions.push(sub);
        return sub;
      },
      unsubscribeAll: () => {
        for (const sub of subscriptions) {
          sub.unsubscribe();
        }
        subscriptions.length = 0;
      },
    };
  }

  /**
   * Add a global connection change callback
   */
  onConnectionChange(callback: (state: ConnectionState) => void): () => void {
    this.connectionChangeCallbacks.add(callback);
    return () => this.connectionChangeCallbacks.delete(callback);
  }

  /**
   * Add a global error callback
   */
  onError(callback: (error: SubscriptionErrorInfo) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Get current connection state
   */
  get connectionState(): ConnectionState {
    return this.transport.connectionState;
  }

  /**
   * Connect to the server
   */
  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  /**
   * Ensure the transport is connected, sharing a single in-flight connect
   * across concurrent callers. Resolves when `onConnectionChange` reports
   * "connected"; rejects if the transport's connect() throws or the
   * auto-connect timeout elapses.
   */
  private ensureConnected(): Promise<void> {
    if (this.transport.connectionState === "connected") {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`ironflow: connect timeout after ${this.autoConnectTimeoutMs}ms`));
      }, this.autoConnectTimeoutMs);

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        unsubscribe();
      };

      const unsubscribe = this.onConnectionChange((state) => {
        if (state === "connected" && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      });

      // Only start a fresh connect if the transport is idle. If it's already
      // "connecting" or "reconnecting", the onConnectionChange listener above
      // will resolve us when the in-flight connect finishes.
      if (this.transport.connectionState === "disconnected") {
        this.transport.connect().then(
          () => {
            // Real transports flip state to "connected" before the connect()
            // promise resolves, so the listener has already fired. The resolve
            // here covers transports / test doubles that don't synthesize a
            // connection-state callback but do signal success by resolving.
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          },
          (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      }
    });

    // .finally returns a NEW promise; store that one so the === check in
    // the cleanup closure can actually match what's held on the instance.
    // Without this, a rejected connect would stay cached forever and the
    // next ensureConnected() caller would get an instant rejection instead
    // of retrying.
    const wrapped = promise.finally(() => {
      if (this.connectPromise === wrapped) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = wrapped;
    return wrapped;
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    this.transport.disconnect();
    this.subscriptions.clear();
    this.patternToId.clear();
    this.pendingPatterns.clear();
    this.patternToPendingKeys.clear();
    this.connectPromise = null;

    if (this.visibilityListener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  /**
   * Pause subscriptions (for tab visibility)
   */
  pause(): void {
    this.transport.pause();
  }

  /**
   * Resume subscriptions
   */
  resume(): void {
    this.transport.resume();
  }

  private handleEvent(subscriptionId: string, event: SubscriptionEvent): void {
    const state = this.subscriptions.get(subscriptionId);
    if (!state) {
      return;
    }

    // Track last event if enabled
    if (state.options?.trackState) {
      state.lastEvent = event as SubscriptionEvent<unknown>;
    }

    state.callbacks.onEvent?.(event);
  }

  private handleError(subscriptionId: string, error: SubscriptionErrorInfo): void {
    // Call global error handlers
    for (const callback of this.errorCallbacks) {
      callback(error);
    }

    // Call subscription-specific error handler
    if (subscriptionId) {
      const state = this.subscriptions.get(subscriptionId);
      state?.callbacks.onError?.(error);
    }
  }

  private handleConnectionChange(state: ConnectionState): void {
    // Update all subscription states
    for (const sub of this.subscriptions.values()) {
      sub.connectionState = state;
      sub.callbacks.onStateChange?.(state);
    }

    // Call global callbacks
    for (const callback of this.connectionChangeCallbacks) {
      callback(state);
    }
  }

  private handleSubscribed(pattern: string, subscriptionId: string): void {
    // Find pending subscription using pattern-to-keys map for O(1) lookup
    const pendingKeys = this.patternToPendingKeys.get(pattern);
    if (!pendingKeys || pendingKeys.length === 0) {
      return;
    }

    // Get the first pending key (FIFO order)
    const pendingKey = pendingKeys.shift()!;
    if (pendingKeys.length === 0) {
      this.patternToPendingKeys.delete(pattern);
    }

    const pending = this.pendingPatterns.get(pendingKey);
    if (!pending) {
      return;
    }

    this.pendingPatterns.delete(pendingKey);

    // Update state with real subscription ID
    pending.id = subscriptionId;
    this.subscriptions.set(subscriptionId, pending);
    this.patternToId.set(pending.lookupKey, subscriptionId);

    // Create subscription object
    const isManualAck = pending.options?.ackMode === "manual";

    if (isManualAck) {
      const ackableSub: AckableSubscription = {
        id: subscriptionId,
        pattern,
        connectionState: pending.connectionState,
        lastEvent: pending.lastEvent,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
        ack: (eventId: string) => this.transport.ack(eventId, "ack"),
        nak: (eventId: string, delay?: number) =>
          this.transport.ack(eventId, "nak", delay),
        term: (eventId: string) => this.transport.ack(eventId, "term"),
      };
      pending.resolve?.(ackableSub);
    } else {
      const sub: Subscription = {
        id: subscriptionId,
        pattern,
        connectionState: pending.connectionState,
        lastEvent: pending.lastEvent,
        unsubscribe: () => this.unsubscribeById(subscriptionId),
      };
      pending.resolve?.(sub);
    }
  }

  private handleSubscribeFailed(pattern: string, error: Error): void {
    // Find pending subscription using pattern-to-keys map for O(1) lookup
    const pendingKeys = this.patternToPendingKeys.get(pattern);
    if (!pendingKeys || pendingKeys.length === 0) {
      return;
    }

    // Get the first pending key (FIFO order)
    const pendingKey = pendingKeys.shift()!;
    if (pendingKeys.length === 0) {
      this.patternToPendingKeys.delete(pattern);
    }

    const pending = this.pendingPatterns.get(pendingKey);
    if (!pending) {
      return;
    }

    this.pendingPatterns.delete(pendingKey);
    pending.reject?.(error);
  }
}
