import { afterEach, describe, expect, it, vi } from "vitest";
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
