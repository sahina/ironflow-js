/**
 * Browser client configuration
 */

import type { Logger } from "@ironflow/core";
import { DEFAULT_SERVER_URL, DEFAULT_RECONNECT, DEFAULT_ENVIRONMENT } from "@ironflow/core";

/**
 * Reconnection configuration
 */
export interface ReconnectConfig {
  /** Enable automatic reconnection (default: true) */
  enabled: boolean;
  /** Maximum reconnection attempts (-1 for infinite, default: 10) */
  maxAttempts: number;
  /** Backoff configuration */
  backoff: {
    /** Initial delay in milliseconds (default: 1000) */
    initial: number;
    /** Maximum delay in milliseconds (default: 30000) */
    max: number;
    /** Backoff multiplier (default: 2) */
    multiplier: number;
  };
}

/**
 * Tab visibility configuration
 */
export interface VisibilityConfig {
  /** Pause subscriptions when tab is hidden (default: true) */
  pauseOnHidden: boolean;
  /** Reconnect when tab becomes visible (default: true) */
  reconnectOnVisible: boolean;
}

/**
 * Authentication configuration (future expansion)
 */
export interface AuthConfig {
  /** API key for authentication */
  apiKey?: string;
  /** Bearer token */
  token?: string;
}

/**
 * Browser client configuration
 */
export interface IronflowConfig {
  /** Ironflow server URL (default: http://localhost:9123) */
  serverUrl: string;
  /** Transport type (default: "connectrpc") */
  transport: "connectrpc" | "websocket";
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Reconnection configuration */
  reconnect: ReconnectConfig;
  /** Tab visibility configuration */
  visibility: VisibilityConfig;
  /** Logger instance (set to false to disable) */
  logger?: Logger | false;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Target environment (default: "default") */
  environment: string;
}

/**
 * User-provided configuration options (all optional with defaults)
 */
export interface IronflowConfigOptions {
  /** Ironflow server URL */
  serverUrl?: string;
  /** Transport type */
  transport?: "connectrpc" | "websocket";
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Reconnection configuration */
  reconnect?: Partial<ReconnectConfig> | boolean;
  /** Tab visibility configuration */
  visibility?: Partial<VisibilityConfig>;
  /** Logger instance (set to false to disable) */
  logger?: Logger | false;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Target environment (default: "default") */
  environment?: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: IronflowConfig = {
  serverUrl: DEFAULT_SERVER_URL,
  transport: "connectrpc",
  reconnect: {
    enabled: DEFAULT_RECONNECT.ENABLED,
    maxAttempts: DEFAULT_RECONNECT.MAX_ATTEMPTS,
    backoff: {
      initial: DEFAULT_RECONNECT.INITIAL_DELAY_MS,
      max: DEFAULT_RECONNECT.MAX_DELAY_MS,
      multiplier: DEFAULT_RECONNECT.MULTIPLIER,
    },
  },
  visibility: {
    pauseOnHidden: true,
    reconnectOnVisible: true,
  },
  environment: DEFAULT_ENVIRONMENT,
};

/**
 * Merge user config with defaults
 */
export function mergeConfig(options: IronflowConfigOptions): IronflowConfig {
  const reconnect: ReconnectConfig =
    typeof options.reconnect === "boolean"
      ? { ...DEFAULT_CONFIG.reconnect, enabled: options.reconnect }
      : {
          enabled: options.reconnect?.enabled ?? DEFAULT_CONFIG.reconnect.enabled,
          maxAttempts: options.reconnect?.maxAttempts ?? DEFAULT_CONFIG.reconnect.maxAttempts,
          backoff: {
            initial: options.reconnect?.backoff?.initial ?? DEFAULT_CONFIG.reconnect.backoff.initial,
            max: options.reconnect?.backoff?.max ?? DEFAULT_CONFIG.reconnect.backoff.max,
            multiplier: options.reconnect?.backoff?.multiplier ?? DEFAULT_CONFIG.reconnect.backoff.multiplier,
          },
        };

  return {
    serverUrl: options.serverUrl ?? DEFAULT_CONFIG.serverUrl,
    transport: options.transport ?? DEFAULT_CONFIG.transport,
    auth: options.auth,
    reconnect,
    visibility: {
      pauseOnHidden: options.visibility?.pauseOnHidden ?? DEFAULT_CONFIG.visibility.pauseOnHidden,
      reconnectOnVisible: options.visibility?.reconnectOnVisible ?? DEFAULT_CONFIG.visibility.reconnectOnVisible,
    },
    logger: options.logger,
    timeout: options.timeout,
    environment: options.environment ?? DEFAULT_CONFIG.environment,
  };
}
