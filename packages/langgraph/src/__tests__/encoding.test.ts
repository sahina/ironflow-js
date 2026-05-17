import { describe, expect, it } from "vitest";
import { b64ToBytes, bytesToB64 } from "../encoding.js";

describe("encoding", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = bytesToB64(bytes);
    const back = b64ToBytes(b64);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("round-trips JSON payload encoded as utf-8", () => {
    const json = JSON.stringify({ greeting: "hello, 世界", n: 42 });
    const bytes = new TextEncoder().encode(json);
    const back = b64ToBytes(bytesToB64(bytes));
    expect(new TextDecoder().decode(back)).toBe(json);
  });

  it("handles empty bytes", () => {
    expect(bytesToB64(new Uint8Array())).toBe("");
    expect(Array.from(b64ToBytes(""))).toEqual([]);
  });
});
