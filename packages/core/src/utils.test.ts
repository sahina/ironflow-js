import { describe, it, expect } from "vitest";
import {
  parseDuration,
  calculateBackoff,
  generateId,
  safeJsonParse,
  isObject,
  deepMerge,
  createDeferred,
  sleep,
} from "./utils.js";

describe("parseDuration", () => {
  it("should parse milliseconds as-is", () => {
    expect(parseDuration(1000)).toBe(1000);
    expect(parseDuration(0)).toBe(0);
  });

  it("should parse seconds", () => {
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("30s")).toBe(30000);
  });

  it("should parse minutes", () => {
    expect(parseDuration("1m")).toBe(60000);
    expect(parseDuration("5m")).toBe(300000);
  });

  it("should parse hours", () => {
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("2h")).toBe(7200000);
  });

  it("should parse days", () => {
    expect(parseDuration("1d")).toBe(86400000);
    expect(parseDuration("7d")).toBe(604800000);
  });

  it("should throw on invalid format", () => {
    expect(() => parseDuration("invalid")).toThrow();
    expect(() => parseDuration("10x")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });
});

describe("calculateBackoff", () => {
  it("should calculate exponential backoff", () => {
    expect(calculateBackoff(1, 1000, 30000)).toBe(1000);
    expect(calculateBackoff(2, 1000, 30000)).toBe(2000);
    expect(calculateBackoff(3, 1000, 30000)).toBe(4000);
  });

  it("should respect max delay", () => {
    expect(calculateBackoff(10, 1000, 5000)).toBe(5000);
    expect(calculateBackoff(100, 1000, 5000)).toBe(5000);
  });

  it("should support custom multiplier", () => {
    expect(calculateBackoff(2, 1000, 30000, 3)).toBe(3000);
    expect(calculateBackoff(3, 1000, 30000, 3)).toBe(9000);
  });
});

describe("generateId", () => {
  it("should generate unique IDs", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it("should generate string IDs", () => {
    expect(typeof generateId()).toBe("string");
  });
});

describe("safeJsonParse", () => {
  it("should parse valid JSON", () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: "value" });
    expect(safeJsonParse("123")).toBe(123);
    expect(safeJsonParse('"string"')).toBe("string");
  });

  it("should return undefined for invalid JSON", () => {
    expect(safeJsonParse("invalid")).toBeUndefined();
    expect(safeJsonParse("{broken")).toBeUndefined();
  });
});

describe("isObject", () => {
  it("should return true for objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ key: "value" })).toBe(true);
  });

  it("should return false for non-objects", () => {
    expect(isObject(null)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject("string")).toBe(false);
    expect(isObject(123)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("should merge objects", () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("should deep merge nested objects", () => {
    const target: Record<string, unknown> = { a: { x: 1, y: 2 }, b: 3 };
    const source: Record<string, unknown> = { a: { y: 4, z: 5 } };
    expect(deepMerge(target, source)).toEqual({
      a: { x: 1, y: 4, z: 5 },
      b: 3,
    });
  });

  it("should not modify original objects", () => {
    const target: Record<string, unknown> = { a: 1 };
    const source: Record<string, unknown> = { b: 2 };
    deepMerge(target, source);
    expect(target).toEqual({ a: 1 });
  });
});

describe("createDeferred", () => {
  it("resolve path triggers promise resolution", async () => {
    const d = createDeferred<string>();
    d.resolve("hello");
    await expect(d.promise).resolves.toBe("hello");
  });

  it("reject path triggers promise rejection", async () => {
    const d = createDeferred<string>();
    d.reject(new Error("fail"));
    await expect(d.promise).rejects.toThrow("fail");
  });

  it("promise is a real Promise instance", () => {
    const d = createDeferred<void>();
    expect(d.promise).toBeInstanceOf(Promise);
    d.resolve(undefined);
  });
});

describe("sleep", () => {
  it("resolves after specified duration", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("resolves with undefined", async () => {
    const result = await sleep(0);
    expect(result).toBeUndefined();
  });
});
