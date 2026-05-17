/**
 * Ironflow Node.js Config Client
 *
 * Config management operations for the Ironflow server.
 */

import type {
  ConfigResponse,
  ConfigEntry,
  ConfigSetResult,
  ConfigWatchEvent,
  ConfigWatchCallbacks,
  ConfigWatcher,
} from "@ironflow/core";
import {
  IronflowError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
} from "@ironflow/core";

import type { OnErrorHandler, ErrorContext } from "./types.js";

export type { ConfigWatchEvent, ConfigWatchCallbacks, ConfigWatcher };

/**
 * Configuration for the config client (inherited from parent client).
 */
export interface ConfigClientConfig {
  serverUrl: string;
  apiKey?: string;
  timeout: number;
  onError?: OnErrorHandler;
}

/**
 * Node.js config client for config management operations.
 */
export class ConfigClient {
  constructor(private readonly config: ConfigClientConfig) {}

  /**
   * Set a config (full document replacement).
   */
  async set(name: string, data: Record<string, unknown>): Promise<ConfigSetResult> {
    return this.restRequest<ConfigSetResult>("POST", `/api/v1/config/${enc(name)}`, data, "config.set");
  }

  /**
   * Get a config by name.
   */
  async get(name: string): Promise<ConfigResponse> {
    return this.restRequest<ConfigResponse>("GET", `/api/v1/config/${enc(name)}`, undefined, "config.get");
  }

  /**
   * Patch a config (shallow merge).
   */
  async patch(name: string, data: Record<string, unknown>): Promise<ConfigSetResult> {
    return this.restRequest<ConfigSetResult>("PATCH", `/api/v1/config/${enc(name)}`, data, "config.patch");
  }

  /**
   * List all configs.
   */
  async list(): Promise<ConfigEntry[]> {
    const result = await this.restRequest<{ configs: ConfigEntry[] }>("GET", "/api/v1/config", undefined, "config.list");
    return result.configs;
  }

  /**
   * Delete a config. Idempotent — succeeds silently if the config does not exist.
   */
  async delete(name: string): Promise<void> {
    await this.restRequest<void>("DELETE", `/api/v1/config/${enc(name)}`, undefined, "config.delete");
  }

  /**
   * Watch a config for real-time changes via WebSocket.
   *
   * Connects to /api/v1/config/{name}/watch and delivers config_update events
   * to the provided callbacks. Returns a ConfigWatcher with a stop() method
   * to close the connection.
   *
   * The Node.js global WebSocket (available since Node 20) is used — no
   * additional dependencies required.
   */
  watch(name: string, callbacks: ConfigWatchCallbacks): ConfigWatcher {
    const serverUrl = this.config.serverUrl;
    const wsUrl = serverUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    const url = `${wsUrl}/api/v1/config/${enc(name)}/watch`;

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // Node 20+ supports the global WebSocket constructor with an options
    // argument that accepts headers (unlike the browser API).
    const ws = new WebSocket(url, { headers } as unknown as string[]);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as ConfigWatchEvent & { message?: string };
        if (data.type === "config_update") {
          callbacks.onUpdate(data as ConfigWatchEvent);
        } else if (data.type === "error") {
          const msg = data.message ?? "config watch error";
          callbacks.onError?.(new Error(msg));
        }
      } catch (err) {
        callbacks.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    };

    ws.onerror = () => {
      callbacks.onError?.(new Error("config watch WebSocket error"));
    };

    ws.onclose = () => {
      callbacks.onClose?.();
    };

    return {
      stop: () => {
        ws.close();
      },
    };
  }

  private async callOnError(error: Error, context: ErrorContext): Promise<void> {
    if (!this.config.onError) return;
    try {
      await this.config.onError(error, context);
    } catch (callbackError) {
      console.error("[ironflow] onError callback threw:", callbackError);
    }
  }

  private async restRequest<T>(
    httpMethod: string,
    path: string,
    body?: unknown,
    clientMethod?: string
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: httpMethod,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Config request failed with status ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throwTypedError(response.status, errorMessage);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (clientMethod) {
        await this.callOnError(error as Error, { method: clientMethod, endpoint: path, statusCode: status });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function throwTypedError(status: number, message: string): never {
  switch (status) {
    case 401:
      throw new UnauthenticatedError(message);
    case 402:
      throw new EnterpriseRequiredError(message);
    case 403:
      throw new UnauthorizedError(message);
    default:
      throw new IronflowError(message);
  }
}
