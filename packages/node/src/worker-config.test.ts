import { describe, it, expect, vi } from "vitest";

// Mock @ironflow/core so getServerUrl() returns a predictable value
// independent of the host process environment.
vi.mock("@ironflow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ironflow/core")>();
  return {
    ...actual,
    getServerUrl: () => "http://from-env:9999",
  };
});

const { createWorker } = await import("./worker.js");

// Reach into the private config to assert resolution. Mirrors how
// worker.test.ts inspects internals; cheaper than fetch interception
// against the start() reconnect loop.
function getResolvedServerUrl(worker: unknown): string {
  return (worker as { config: { serverUrl: string } }).config.serverUrl;
}

describe("createWorker serverUrl resolution", () => {
  it("uses explicit config.serverUrl when provided", () => {
    const worker = createWorker({
      serverUrl: "http://explicit:8080",
      functions: [],
    });
    expect(getResolvedServerUrl(worker)).toBe("http://explicit:8080");
  });

  it("falls back to getServerUrl() when config.serverUrl is absent", () => {
    const worker = createWorker({ functions: [] });
    expect(getResolvedServerUrl(worker)).toBe("http://from-env:9999");
  });

  it("falls back to getServerUrl() when config.serverUrl is empty string", () => {
    const worker = createWorker({ serverUrl: "", functions: [] });
    expect(getResolvedServerUrl(worker)).toBe("http://from-env:9999");
  });
});

describe("createWorker default fallback (no env)", () => {
  it("uses DEFAULT_SERVER_URL when config and env are both absent", async () => {
    // Reset modules so a fresh mock takes effect.
    vi.resetModules();
    vi.doMock("@ironflow/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@ironflow/core")>();
      return {
        ...actual,
        getServerUrl: () => actual.DEFAULT_SERVER_URL,
      };
    });

    try {
      const { createWorker: freshCreateWorker } = await import("./worker.js");
      const { DEFAULT_SERVER_URL } = await import("@ironflow/core");

      const worker = freshCreateWorker({ functions: [] });
      expect(getResolvedServerUrl(worker)).toBe(DEFAULT_SERVER_URL);
    } finally {
      vi.doUnmock("@ironflow/core");
    }
  });
});
