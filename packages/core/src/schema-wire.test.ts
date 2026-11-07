import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import { schemaFromWire } from "./schema-wire.js";

describe("schemaFromWire created_at", () => {
  it("decodes a timestamp to a Date", () => {
    const stamp = "2026-01-02T03:04:05Z";
    expect(schemaFromWire({ createdAt: stamp }).created_at).toEqual(new Date(stamp));
  });

  it.each([[undefined], [""], ["0001-01-01T00:00:00Z"]])("leaves %j absent", (createdAt) => {
    expect(schemaFromWire({ createdAt })).not.toHaveProperty("created_at");
  });

  it("throws SchemaValidationError for an unreadable value", () => {
    expect(() => schemaFromWire({ createdAt: "now" })).toThrow(SchemaValidationError);
  });
});
