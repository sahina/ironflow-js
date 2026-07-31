// Code-hash reload signal (#1280). functionCodeHash stamps a deterministic hash of
// the handler source into register metadata so the engine bumps the function
// version on a code edit (making ironflow_await_reload + the desktop staleness chip
// fire), while an identical dev-process restart re-registers the same hash and does
// NOT inflate the version.

import { describe, it, expect } from "vitest";
import { functionCodeHash, CODE_HASH_META_KEY } from "./worker.js";

describe("functionCodeHash (#1280 reload detection)", () => {
  it("is a short hex digest", () => {
    expect(functionCodeHash(async () => 1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across distinct instances with identical source (no version inflation on restart)", () => {
    // Two separate function objects, byte-identical source — a plain dev restart.
    const make = () => async (x: number) => x + 1;
    expect(functionCodeHash(make())).toBe(functionCodeHash(make()));
  });

  it("changes when the handler body changes (a code edit bumps the version)", () => {
    const before = async () => ({ status: "draft" });
    const after = async () => ({ status: "published" });
    expect(functionCodeHash(before)).not.toBe(functionCodeHash(after));
  });

  it("uses a reserved (__-prefixed) key so it can't collide with user metadata", () => {
    expect(CODE_HASH_META_KEY.startsWith("__")).toBe(true);
  });
});
