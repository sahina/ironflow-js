/**
 * Ironflow Browser Config Client
 *
 * Config management operations for browser-based applications.
 * Provides set, get, patch, list, delete, and watch capabilities.
 */

import type {
  ConfigResponse,
  ConfigEntry,
  ConfigSetResult,
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
   * Set a config (full document replacement).
   */
  async set(name: string, data: Record<string, unknown>): Promise<ConfigSetResult> {
    return this.restRequest<ConfigSetResult>("POST", `/api/v1/config/${enc(name)}`, data);
  }

  /**
   * Get a config by name.
   */
  async get(name: string): Promise<ConfigResponse> {
    return this.restRequest<ConfigResponse>("GET", `/api/v1/config/${enc(name)}`);
  }

  /**
   * Patch a config (shallow merge).
   */
  async patch(name: string, data: Record<string, unknown>): Promise<ConfigSetResult> {
    return this.restRequest<ConfigSetResult>("PATCH", `/api/v1/config/${enc(name)}`, data);
  }

  /**
   * List all configs.
   */
  async list(): Promise<ConfigEntry[]> {
    const result = await this.restRequest<{ configs: ConfigEntry[] }>("GET", "/api/v1/config");
    return result.configs;
  }

  /**
   * Delete a config. Idempotent — succeeds silently if the config does not exist.
   */
  async delete(name: string): Promise<void> {
    await this.restRequest<void>("DELETE", `/api/v1/config/${enc(name)}`);
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
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const timeout = this.config.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config.environment,
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (this.config.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
