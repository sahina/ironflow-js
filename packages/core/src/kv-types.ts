/**
 * KV API Type Definitions
 *
 * Types for the Ironflow Key-Value store API.
 */

// ============================================================================
// Bucket Types
// ============================================================================

/**
 * Configuration for creating a KV bucket.
 */
export interface KVBucketConfig {
  /** Bucket name */
  name: string;
  /** Optional description */
  description?: string;
  /** Time-to-live in seconds. Zero means no expiry. */
  ttlSeconds?: number;
  /** Maximum value size in bytes */
  maxValueSize?: number;
  /** Maximum total bucket size in bytes */
  maxBytes?: number;
  /** Number of historical values to keep per key (default: 1) */
  history?: number;
}

/**
 * Information about an existing KV bucket.
 */
export interface KVBucketInfo {
  /** Bucket name */
  name: string;
  /** Description */
  description?: string;
  /** TTL in seconds */
  ttl_seconds?: number;
  /** Number of values (including history) */
  values: number;
  /** Total size in bytes */
  bytes: number;
  /** History depth */
  history: number;
  /** When the bucket was created */
  created_at: string;
}

// ============================================================================
// Key/Value Types
// ============================================================================

/**
 * A key-value entry.
 */
export interface KVEntry {
  /** The key */
  key: string;
  /** The value (raw bytes as base64 or string depending on content type) */
  value: unknown;
  /** Revision number */
  revision: number;
  /** When the entry was created/updated */
  created_at: string;
  /** Operation type: "put" or "delete" */
  operation: string;
}

/**
 * Result of a put/create/update operation.
 */
export interface KVPutResult {
  /** New revision number */
  revision: number;
}

/**
 * Result of listing keys.
 */
export interface KVListKeysResult {
  /** Matching keys */
  keys: string[];
  /** Number of keys */
  count: number;
}

/**
 * Result of listing buckets.
 */
export interface KVListBucketsResult {
  /** Bucket info list */
  buckets: KVBucketInfo[];
  /** Number of buckets */
  count: number;
}

// ============================================================================
// Watch Types
// ============================================================================

/**
 * A KV watch event delivered over WebSocket.
 */
export interface KVWatchEvent {
  /** Message type, always "kv_update" */
  type: "kv_update";
  /** The key that changed */
  key: string;
  /** The new value (empty for deletes) */
  value: string;
  /** Revision number */
  revision: number;
  /** Operation: "put" or "delete" */
  operation: "put" | "delete";
  /** Bucket name */
  bucket: string;
}

/**
 * Callbacks for KV watch events.
 */
export interface KVWatchCallbacks {
  /** Called when a key is updated or deleted */
  onUpdate: (event: KVWatchEvent) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called when the watch connection closes */
  onClose?: () => void;
}

/**
 * Options for watching KV changes.
 */
export interface KVWatchOptions {
  /** Key pattern to watch (e.g., "user.*", "session.>"). Empty means all keys. */
  key?: string;
}

/**
 * A KV watcher that can be stopped.
 */
export interface KVWatcher {
  /** Stop watching */
  stop: () => void;
}
