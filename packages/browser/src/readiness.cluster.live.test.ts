// @vitest-environment node
/**
 * Live test: health-ready and capabilities-discovery (#3003) through the
 * browser client. Its health() reads GET /health and its ready() GET /ready. Skips unless IRONFLOW_READINESS_SEED is set;
 * `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;

describe.skipIf(!process.env["IRONFLOW_READINESS_SEED"])("readiness cluster — live server", () => {
  ironflow.configure({ serverUrl: SERVER, auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] } });

  it("capabilities-discovery", async () => {
    const caps = await ironflow.getCapabilities();
    expect(caps.version).toBeTruthy();
    expect(caps.transports).toContain("websocket");
    expect(caps.features).toEqual(expect.arrayContaining(["replay", "wildcard-patterns"]));
    // The client type drops the other fields, so read them off the wire.
    const wire = (await (await fetch(`${SERVER}/api/v1/capabilities`)).json()) as Record<string, unknown>;
    expect(wire).toMatchObject({ version: caps.version, auth_required: true });
    expect(wire["files_max_object_bytes"]).toBeGreaterThan(0);
  });

  it("health-ready", async () => {
    const caps = await ironflow.getCapabilities();
    const health = await ironflow.health();
    expect(health).toMatchObject({ status: "healthy", version: caps.version });
    expect(Math.abs(Date.now() - Date.parse(health.timestamp))).toBeLessThan(60_000);
    expect(await ironflow.ready()).toMatchObject({ status: "ready" });
  });
});
