import { describe, it, expect } from "vitest";

import { encodeProtoBytes, decodeProtoBytes } from "./proto-bytes.js";

// Proto `bytes` fields cross protojson as base64, not raw JSON. Sending raw
// JSON text is rejected by the server before the handler runs, and reading a
// response without decoding hands the caller base64 (#1919).
describe("proto bytes helpers", () => {
  it("encodes a value to base64 of its JSON", () => {
    expect(encodeProtoBytes({ corrected: true })).toBe("eyJjb3JyZWN0ZWQiOnRydWV9");
  });

  it("decodes base64 back to the value", () => {
    expect(decodeProtoBytes("eyJvbGRfdmFsdWUiOjEwMH0=")).toEqual({
      old_value: 100,
    });
  });

  it("round-trips nested payloads", () => {
    const value = { nested: { array: [1, 2, 3], flag: true }, count: 99 };
    expect(decodeProtoBytes(encodeProtoBytes(value))).toEqual(value);
  });

  // null is a valid JSON document; collapsing it to an empty bytes field would
  // persist an unparseable step output on the server.
  it("encodes null as JSON null, not as an empty field", () => {
    expect(encodeProtoBytes(null)).toBe("bnVsbA==");
    expect(decodeProtoBytes(encodeProtoBytes(null))).toBeNull();
  });

  // EmitUnpopulated:false means an empty bytes field is an absent key.
  it("treats empty and missing as null", () => {
    expect(decodeProtoBytes("")).toBeNull();
    expect(decodeProtoBytes(undefined)).toBeNull();
    expect(decodeProtoBytes(null)).toBeNull();
    expect(encodeProtoBytes(undefined)).toBe("");
  });

  // The pre-#1919 bug: raw JSON where base64 was required.
  it("does not emit raw JSON", () => {
    expect(encodeProtoBytes({ a: 1 })).not.toBe('{"a":1}');
  });
});
