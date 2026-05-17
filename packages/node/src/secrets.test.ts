import { describe, it, expect } from "vitest";
import { createSecretsClient } from "./secrets.js";

describe("SecretsClient", () => {
  it("gets a known secret", () => {
    const client = createSecretsClient({ API_KEY: "sk-123" });
    expect(client.get("API_KEY")).toBe("sk-123");
  });

  it("throws for unknown secret", () => {
    const client = createSecretsClient({});
    expect(() => client.get("MISSING")).toThrow('Secret "MISSING" not found');
  });

  it("has returns true for known secret", () => {
    const client = createSecretsClient({ DB_URL: "postgres://..." });
    expect(client.has("DB_URL")).toBe(true);
    expect(client.has("MISSING")).toBe(false);
  });

  it("handles empty map", () => {
    const client = createSecretsClient({});
    expect(client.has("ANY")).toBe(false);
  });

  it("handles undefined map", () => {
    const client = createSecretsClient(undefined);
    expect(client.has("ANY")).toBe(false);
  });
});
