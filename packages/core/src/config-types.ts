/**
 * Config Management API Type Definitions
 *
 * Types for the Ironflow Config Management service.
 * Config Management provides environment-scoped configuration
 * built on top of the KV store.
 */

// ============================================================================
// Response Types
// ============================================================================

/**
 * A config entry with full data.
 * Returned by GET /api/v1/config/{name}.
 */
export interface ConfigResponse {
  /** Config namespace name */
  name: string;
  /** Config data as key-value pairs */
  data: Record<string, unknown>;
  /** KV revision number for optimistic concurrency */
  revision: number;
  /** When the config was last updated */
  updatedAt: string;
}

/**
 * Summary of a config entry (without full data).
 * Returned in list responses.
 */
export interface ConfigEntry {
  /** Config namespace name */
  name: string;
  /** KV revision number */
  revision: number;
  /** When the config was last updated */
  updatedAt: string;
}

/**
 * Result of a set or patch operation.
 */
export interface ConfigSetResult {
  /** Config namespace name */
  name: string;
  /** New KV revision number */
  revision: number;
}

// ============================================================================
// Watch Types
// ============================================================================

/**
 * A config watch event received over the WebSocket stream.
 * Emitted by the server when a config document is created or updated.
 */
export interface ConfigWatchEvent {
  /** Message type — always "config_update" for data events */
  type: string;
  /** Config namespace name */
  name: string;
  /** Current config data as key-value pairs */
  data: Record<string, unknown>;
  /** KV revision number after this update */
  revision: number;
  /** ISO-8601 timestamp of the update */
  updatedAt: string;
}

/**
 * Callbacks for config watch events.
 */
export interface ConfigWatchCallbacks {
  /** Called when a config is updated */
  onUpdate: (event: ConfigWatchEvent) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called when the WebSocket connection is closed */
  onClose?: () => void;
}

/**
 * A handle returned by config watch that allows stopping the watch.
 */
export interface ConfigWatcher {
  /** Stop watching and close the WebSocket connection */
  stop: () => void;
}
