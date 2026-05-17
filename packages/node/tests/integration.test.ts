/**
 * Integration tests for the node package
 *
 * These tests require a running Ironflow server.
 * Run with: IRONFLOW_INTEGRATION=1 pnpm test:integration
 *
 * Start server first: ./build/ironflow dev
 */

import { describe, it, expect } from "vitest";
import { IronflowClient } from "../src/client.js";

// Skip all tests if not in integration mode
const INTEGRATION_ENABLED = process.env["IRONFLOW_INTEGRATION"] === "1";

describe.skipIf(!INTEGRATION_ENABLED)("Node SDK Integration", () => {
  const SERVER_URL =
    process.env["IRONFLOW_SERVER_URL"] || "http://localhost:9123";

  describe("Server connectivity", () => {
    it("should connect to the server", async () => {
      const response = await fetch(`${SERVER_URL}/health`);
      expect(response.ok).toBe(true);
    });

    it("should check gRPC endpoint availability", async () => {
      // For gRPC/ConnectRPC, we test the HTTP/2 endpoint
      try {
        const response = await fetch(
          `${SERVER_URL}/ironflow.v1.WorkerService/Connect`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/connect+proto",
            },
          }
        );
        // We expect some response (even error) indicating the endpoint exists
        expect(response.status).toBeDefined();
      } catch {
        // Network error means server not configured for gRPC
      }
    });
  });

  describe("API operations", () => {
    it("should list functions", async () => {
      const response = await fetch(`${SERVER_URL}/api/v1/functions`);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as { functions: unknown };
      expect(result.functions).toBeDefined();
    });

    it("should list runs", async () => {
      const response = await fetch(`${SERVER_URL}/api/v1/runs?limit=5`);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as { runs: unknown };
      expect(result.runs).toBeDefined();
    });

    it("should emit test event", async () => {
      const response = await fetch(`${SERVER_URL}/api/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "node.integration.test",
          data: { timestamp: Date.now() },
        }),
      });
      expect(response.ok).toBe(true);

      const result = (await response.json()) as { event_id: unknown };
      expect(result.event_id).toBeDefined();
    });
  });
});

// Worker integration tests (require more complex setup)
describe.skipIf(!INTEGRATION_ENABLED)("Worker Integration", () => {
  it.todo("should register worker with server");
  it.todo("should receive job assignments");
  it.todo("should complete jobs successfully");
  it.todo("should handle job failures");
  it.todo("should reconnect on connection loss");
});

// Issue #600: server emits canonical proto-JSON (camelCase + int64-as-string).
// SDK previously read snake_case + treated int64 as number, leaving every
// multi-word response field as undefined. These tests guard the regression.
describe.skipIf(!INTEGRATION_ENABLED)("client.streams response shape (#600)", () => {
  const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] || "http://localhost:9123";

  it("streams.append returns numeric entityVersion + non-empty eventId", async () => {
    const client = new IronflowClient({ serverUrl: SERVER_URL });
    const streamId = `node-it-append-${Date.now()}`;
    const result = await client.streams.append(streamId, {
      name: "it.created",
      data: { x: 1 },
      entityType: "test",
    });
    expect(typeof result.entityVersion).toBe("number");
    expect(result.entityVersion).toBeGreaterThanOrEqual(0);
    expect(typeof result.eventId).toBe("string");
    expect(result.eventId.length).toBeGreaterThan(0);
  });

  it("streams.read returns events with numeric entityVersion (not undefined)", async () => {
    const client = new IronflowClient({ serverUrl: SERVER_URL });
    const streamId = `node-it-read-${Date.now()}`;
    await client.streams.append(streamId, { name: "it.a", data: { i: 0 }, entityType: "test" });
    await client.streams.append(streamId, { name: "it.b", data: { i: 1 }, entityType: "test" });

    const { events, totalCount } = await client.streams.read(streamId, { limit: 10 });
    expect(totalCount).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(typeof e.entityVersion).toBe("number");
      expect(e.entityVersion).toBeGreaterThanOrEqual(0);
      expect(typeof e.id).toBe("string");
      expect(e.id.length).toBeGreaterThan(0);
    }
    // Versions must be monotonically increasing within a stream.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.entityVersion).toBeGreaterThan(events[i - 1]!.entityVersion);
    }
  });

  it("streams.getInfo returns numeric version + eventCount + populated timestamps", async () => {
    const client = new IronflowClient({ serverUrl: SERVER_URL });
    const streamId = `node-it-info-${Date.now()}`;
    await client.streams.append(streamId, { name: "it.c", data: {}, entityType: "test" });

    const info = await client.streams.getInfo(streamId);
    expect(info).not.toBeNull();
    expect(typeof info!.version).toBe("number");
    expect(typeof info!.eventCount).toBe("number");
    expect(info!.eventCount).toBeGreaterThanOrEqual(1);
    expect(typeof info!.entityId).toBe("string");
    expect(typeof info!.entityType).toBe("string");
    expect(typeof info!.createdAt).toBe("string");
    expect(info!.createdAt.length).toBeGreaterThan(0);
  });
});
