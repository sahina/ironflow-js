import { describe, expect, it } from "vitest";
import { auditEventFromWire } from "./audit-wire.js";
import { SchemaValidationError } from "./errors.js";
import { AuditEventSchema, validate } from "./schemas.js";

const STAMP = "2026-01-02T03:04:05.123456789Z";

describe("auditEventFromWire", () => {
  it("decodes createdAt from protojson and REST casing", () => {
    expect(auditEventFromWire({ id: "a", createdAt: STAMP }).createdAt).toEqual(new Date(STAMP));
    expect(auditEventFromWire({ id: "a", created_at: STAMP }).createdAt).toEqual(new Date(STAMP));
  });

  it.each([["now"], [""], [undefined], [null]])("throws SchemaValidationError for createdAt %j", (createdAt) => {
    expect(() => auditEventFromWire({ id: "a", createdAt })).toThrow(SchemaValidationError);
  });
});

describe("AuditEventSchema", () => {
  const event = { id: "a", runId: "r", functionId: "f", eventType: "run.created", payload: {} };

  it("parses createdAt to a Date", () => {
    expect(AuditEventSchema.parse({ ...event, createdAt: STAMP }).createdAt).toEqual(new Date(STAMP));
  });

  it("fails an unreadable createdAt with SchemaValidationError", () => {
    expect(() => validate(AuditEventSchema, { ...event, createdAt: "now" }, "audit")).toThrow(SchemaValidationError);
  });
});
