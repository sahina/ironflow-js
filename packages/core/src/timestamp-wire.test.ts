import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import { optionalTimestampFromWire, timestampFilterToWire, timestampFromWire } from "./timestamp-wire.js";

describe("timestampFromWire", () => {
  it("decodes RFC 3339, cutting sub-millisecond digits", () => {
    expect(timestampFromWire("f", "2026-08-27T12:00:00Z")).toEqual(new Date(Date.UTC(2026, 7, 27, 12)));
    expect(timestampFromWire("f", "2026-08-27T12:00:00.123456789Z").getTime()).toBe(
      Date.UTC(2026, 7, 27, 12, 0, 0, 123),
    );
  });

  it.each([[undefined], [null], [""], ["not a date"], [1787832000000]])(
    "throws on %j and names the field",
    (value) => {
      expect(() => timestampFromWire("run.createdAt", value)).toThrow(SchemaValidationError);
      expect(() => timestampFromWire("run.createdAt", value)).toThrow(/run\.createdAt/);
    },
  );
});

describe("timestampFilterToWire", () => {
  it("sends a string unchanged and a Date as RFC 3339", () => {
    expect(timestampFilterToWire("2026-08-27T12:00:00.123456789Z")).toBe("2026-08-27T12:00:00.123456789Z");
    expect(timestampFilterToWire(new Date("2026-08-27T12:00:00Z"))).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("optionalTimestampFromWire", () => {
  it.each([[undefined], [null], [""]])("treats %j as absent", (value) => {
    expect(optionalTimestampFromWire("f", value)).toBeUndefined();
  });

  it("decodes a present value and throws on an unreadable one", () => {
    expect(optionalTimestampFromWire("f", "2026-08-27T12:00:00Z")).toBeInstanceOf(Date);
    expect(() => optionalTimestampFromWire("f", "not a date")).toThrow(SchemaValidationError);
  });
});
