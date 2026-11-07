import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaValidationError } from "@ironflow/core";
import type { IronflowConfig } from "./config.js";
import { BrowserConfigClient } from "./config-client.js";

const config = { serverUrl: "http://localhost:9123", environment: "test-env" } as IronflowConfig;
const client = () => new BrowserConfigClient(config, vi.fn());
const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("BrowserConfigClient retry flag", () => {
  it("uses the status rule, with 501 not retryable", async () => {
    reply(503, { error: "busy" });
    await expect(client().list()).rejects.toMatchObject({ retryable: true });
    reply(501, { error: "no route" });
    await expect(client().list()).rejects.toMatchObject({ retryable: false });
  });

  it("lets the body retryable flag win", async () => {
    reply(507, { error: "disk full", retryable: false });
    await expect(client().list()).rejects.toMatchObject({ retryable: false });
    reply(409, { error: "busy", retryable: true });
    await expect(client().list()).rejects.toMatchObject({ retryable: true });
  });
});

describe("BrowserConfigClient.watch", () => {
  it("listens on updated and deleted, and passes a delete through as data null (#2949)", async () => {
    let onEvent: ((e: { data: unknown }) => void) | undefined;
    const subscribe = vi.fn(async (_pattern: string, cb: { onEvent: typeof onEvent }) => {
      onEvent = cb.onEvent;
      return { unsubscribe: vi.fn() } as never;
    });
    const onUpdate = vi.fn();
    await new BrowserConfigClient(config, subscribe as never).watch("theme", { onUpdate });
    expect(subscribe.mock.calls[0]![0]).toBe("system.config.theme.*");
    onEvent!({ data: { name: "theme", revision: 9, data: null, updatedAt: "2026-10-16T00:00:00Z" } });
    expect(onUpdate).toHaveBeenCalledWith({ type: "config_update", name: "theme", revision: 9, data: null, updatedAt: new Date("2026-10-16T00:00:00Z") });
  });

  it("routes an unreadable updatedAt to onError, and never throws into the transport", async () => {
    let onEvent: ((e: { data: unknown }) => void) | undefined;
    const subscribe = vi.fn(async (_pattern: string, cb: { onEvent: typeof onEvent }) => {
      onEvent = cb.onEvent;
      return { unsubscribe: vi.fn() } as never;
    });
    const onUpdate = vi.fn();
    const onError = vi.fn();
    await new BrowserConfigClient(config, subscribe as never).watch("theme", { onUpdate, onError });
    onEvent!({ data: { name: "theme", revision: 9, data: {}, updatedAt: "not-a-time" } });
    expect(onError).toHaveBeenCalledWith(expect.any(SchemaValidationError));
    expect(onUpdate).not.toHaveBeenCalled();

    await new BrowserConfigClient(config, subscribe as never).watch("theme", { onUpdate });
    expect(() => onEvent!({ data: { name: "theme", revision: 9, data: {} } })).not.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("decodes get and list, and throws on an unreadable updatedAt", async () => {
    reply(200, { name: "theme", data: {}, revision: 1, updatedAt: "2026-10-16T00:00:00Z" });
    expect((await client().get("theme")).updatedAt).toEqual(new Date("2026-10-16T00:00:00Z"));
    reply(200, { configs: [{ name: "theme", revision: 1, updatedAt: "2026-10-16T00:00:00Z" }] });
    expect((await client().list())[0]!.updatedAt).toEqual(new Date("2026-10-16T00:00:00Z"));
    reply(200, { name: "theme", data: {}, revision: 1, updatedAt: "not-a-time" });
    await expect(client().get("theme")).rejects.toBeInstanceOf(SchemaValidationError);
    reply(200, { configs: [{ name: "theme", revision: 1 }] });
    await expect(client().list()).rejects.toBeInstanceOf(SchemaValidationError);
  });
});
