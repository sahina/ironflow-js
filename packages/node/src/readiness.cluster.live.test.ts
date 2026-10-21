/**
 * Live test: health-ready and capabilities-discovery (#3003) through the Node
 * client. Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;

describe.skipIf(!process.env["IRONFLOW_READINESS_SEED"])("readiness cluster — live server", () => {
  const client = new IronflowClient({ serverUrl: SERVER, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
  // These routes are public: no key is sent.
  const publicGet = async (path: string) => {
    const res = await fetch(`${SERVER}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("capabilities-discovery", async () => {
    const caps = await client.getCapabilities();
    expect(caps.version).toBeTruthy();
    expect(caps.transports).toContain("websocket");
    expect(caps.features).toEqual(expect.arrayContaining(["replay", "wildcard-patterns"]));
    // The SDK type drops the other fields, so read them off the wire.
    const wire = await publicGet("/api/v1/capabilities");
    expect(wire.status).toBe(200);
    expect(wire.body).toMatchObject({ version: caps.version, auth_required: true });
    expect(wire.body["files_max_object_bytes"]).toBeGreaterThan(0);
  });

  it("health-ready", async () => {
    // The Connect Health RPC the SDK calls.
    expect(await client.health()).toBe("healthy");
    const caps = await client.getCapabilities();
    const health = await publicGet("/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "healthy", version: caps.version });
    expect(Math.abs(Date.now() - Date.parse(health.body["timestamp"] as string))).toBeLessThan(60_000);
    expect(await client.ready()).toMatchObject({ status: "ready" });
  });
});
