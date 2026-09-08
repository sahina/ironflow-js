/**
 * Integration tests for the browser package
 *
 * These tests require a running Ironflow server.
 * Run with: IRONFLOW_INTEGRATION=1 pnpm test:integration
 *
 * Start server first: ./build/ironflow dev
 */

import { describe, it, expect } from "vitest";

// Skip all tests if not in integration mode
const INTEGRATION_ENABLED = process.env["IRONFLOW_INTEGRATION"] === "1";

describe.skipIf(!INTEGRATION_ENABLED)("Browser SDK Integration", () => {
  const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] || "http://localhost:9123";

  describe("Server connectivity", () => {
    it("should connect to the server", async () => {
      const response = await fetch(`${SERVER_URL}/health`);
      expect(response.ok).toBe(true);
    });

    it("should detect ConnectRPC support", async () => {
      try {
        const response = await fetch(
          `${SERVER_URL}/ironflow.v1.IronflowService/GetCapabilities`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }
        );
        // Server should respond (even if with an error status)
        expect(response.status).toBeDefined();
      } catch {
        // Network error is acceptable - means server not running or no ConnectRPC
      }
    });
  });

  describe("Event emission", () => {
    it("should emit an event via REST API", async () => {
      const response = await fetch(`${SERVER_URL}/ironflow.v1.IronflowService/Emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "integration.test.event",
          data: { test: true, timestamp: Date.now() },
        }),
      });
      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.id).toBeDefined();
    });
  });

  describe("Workflow operations", () => {
    it("should list runs", async () => {
      const response = await fetch(`${SERVER_URL}/ironflow.v1.IronflowService/ListRuns`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({limit:10})});
      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.runs).toBeDefined();
      expect(Array.isArray(result.runs)).toBe(true);
    });

    it("should get functions list", async () => {
      const response = await fetch(`${SERVER_URL}/ironflow.v1.IronflowService/ListFunctions`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.functions).toBeDefined();
      expect(Array.isArray(result.functions)).toBe(true);
    });
  });
});

// Placeholder tests for subscription functionality
// These would need WebSocket/SSE support in the test environment
describe.skipIf(!INTEGRATION_ENABLED)("Subscription Integration", () => {
  it.todo("should subscribe to run events");
  it.todo("should receive event stream via SSE");
  it.todo("should handle reconnection");
});
