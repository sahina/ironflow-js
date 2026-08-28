/**
 * Ironflow Browser Config Client
 *
 * Config management operations for browser-based applications.
 * Provides read and watch capabilities. Config mutations are intentionally
 * server-side and are not exposed to browser applications.
 */

import type {
  ConfigResponse,
  ConfigEntry,
  ConfigWatchCallbacks,
  ConfigWatchEvent,
  Subscription,
  SubscriptionCallbacks,
} from "@ironflow/core";
import { IronflowError, DEFAULT_TIMEOUTS, HEADERS } from "@ironflow/core";
import type { IronflowConfig } from "./config.js";

/**
 * Browser config client for config management operations.
 */
export class BrowserConfigClient {
  private readonly config: IronflowConfig;
  private readonly subscribeFn: (
    pattern: string,
    callbacks: SubscriptionCallbacks & Record<string, unknown>
  ) => Promise<Subscription>;

  constructor(
    config: IronflowConfig,
    subscribeFn: (
      pattern: string,
      callbacks: SubscriptionCallbacks & Record<string, unknown>
    ) => Promise<Subscription>
  ) {
    this.config = config;
    this.subscribeFn = subscribeFn;
  }

  /**
   * Get a config by name.
   */
  async get(name: string): Promise<ConfigResponse> {
    return this.restRequest<ConfigResponse>("GET", `/api/v1/config/${enc(name)}`);
  }

  /**
   * List all configs.
   */
  async list(): Promise<ConfigEntry[]> {
    const result = await this.restRequest<{ configs: ConfigEntry[] }>("GET", "/api/v1/config");
    return result.configs;
  }

  /**
   * Watch for changes to a config.
   * Uses WebSocket subscription on system.config.{name}.updated topic.
   */
  async watch(name: string, callbacks: ConfigWatchCallbacks): Promise<Subscription> {
    const pattern = `system.config.${name}.updated`;
    return this.subscribeFn(pattern, {
      onEvent: (event) => {
        const payload = event.data as unknown as ConfigResponse;
        const watchEvent: ConfigWatchEvent = {
          type: "config_update",
          ...payload,
        };
        callbacks.onUpdate(watchEvent);
      },
      onError: callbacks.onError
        ? (info) => callbacks.onError!(new IronflowError(info.message, { code: info.code, retryable: false }))
        : undefined,
    });
  }

  private async restRequest<T>(
    method: string,
    path: string
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const timeout = this.config.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config.environment,
      };

      const credential =
        this.config.auth?.apiKey || this.config.auth?.token;
      if (credential) {
        headers["Authorization"] = `Bearer ${credential}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Config request failed: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throw new IronflowError(errorMessage, {
          code: `HTTP_${response.status}`,
          retryable: response.status >= 500,
        });
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (error instanceof IronflowError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(`Config request timeout after ${timeout}ms`, {
          code: "TIMEOUT",
          retryable: true,
        });
      }
      throw new IronflowError(`Config ${method} ${path} failed`, {
        code: "REQUEST_FAILED",
        retryable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
