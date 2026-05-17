import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, createNoopLogger, type LogLevel } from "./logger.js";

describe("createLogger", () => {
  let consoleMocks: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    // Set up fresh spies before each test
    consoleMocks = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    // Reset environment
    delete process.env.IRONFLOW_LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("default behavior", () => {
    it("should create a logger with default prefix", () => {
      const logger = createLogger();
      logger.info("test message");
      expect(consoleMocks.info).toHaveBeenCalledWith("[ironflow] test message");
    });

    it("should use custom prefix", () => {
      const logger = createLogger({ prefix: "[custom]" });
      logger.info("test message");
      expect(consoleMocks.info).toHaveBeenCalledWith("[custom] test message");
    });

    it("should format data as JSON", () => {
      const logger = createLogger();
      logger.info("test", { key: "value" });
      expect(consoleMocks.info).toHaveBeenCalledWith('[ironflow] test {"key":"value"}');
    });
  });

  describe.each<[LogLevel, string[]]>([
    ["debug", ["debug", "info", "warn", "error"]],
    ["info", ["info", "warn", "error"]],
    ["warn", ["warn", "error"]],
    ["error", ["error"]],
    ["silent", []],
  ])("level %s", (level, expectedMethods) => {
    it(`should output only: ${expectedMethods.length > 0 ? expectedMethods.join(", ") : "nothing"}`, () => {
      const logger = createLogger({ level });

      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      if (expectedMethods.includes("debug")) {
        expect(consoleMocks.debug).toHaveBeenCalled();
      } else {
        expect(consoleMocks.debug).not.toHaveBeenCalled();
      }

      if (expectedMethods.includes("info")) {
        expect(consoleMocks.info).toHaveBeenCalled();
      } else {
        expect(consoleMocks.info).not.toHaveBeenCalled();
      }

      if (expectedMethods.includes("warn")) {
        expect(consoleMocks.warn).toHaveBeenCalled();
      } else {
        expect(consoleMocks.warn).not.toHaveBeenCalled();
      }

      if (expectedMethods.includes("error")) {
        expect(consoleMocks.error).toHaveBeenCalled();
      } else {
        expect(consoleMocks.error).not.toHaveBeenCalled();
      }
    });
  });

  describe("environment variable override", () => {
    it("should use IRONFLOW_LOG_LEVEL environment variable", () => {
      process.env.IRONFLOW_LOG_LEVEL = "debug";
      const logger = createLogger();

      logger.debug("debug message");
      expect(consoleMocks.debug).toHaveBeenCalled();
    });

    it("should handle case-insensitive environment variable", () => {
      process.env.IRONFLOW_LOG_LEVEL = "DEBUG";
      const logger = createLogger();

      logger.debug("debug message");
      expect(consoleMocks.debug).toHaveBeenCalled();
    });

    it("should ignore invalid environment variable value", () => {
      process.env.IRONFLOW_LOG_LEVEL = "invalid";
      const logger = createLogger();

      // Should default to info level
      logger.debug("debug message");
      logger.info("info message");
      expect(consoleMocks.debug).not.toHaveBeenCalled();
      expect(consoleMocks.info).toHaveBeenCalled();
    });
  });

  describe("data formatting", () => {
    it("should omit data suffix when data is undefined", () => {
      const logger = createLogger();
      logger.info("message only");
      expect(consoleMocks.info).toHaveBeenCalledWith("[ironflow] message only");
    });

    it("should handle empty data object", () => {
      const logger = createLogger();
      logger.info("message", {});
      expect(consoleMocks.info).toHaveBeenCalledWith("[ironflow] message {}");
    });

    it("should handle nested data", () => {
      const logger = createLogger();
      logger.info("message", { nested: { deep: "value" } });
      expect(consoleMocks.info).toHaveBeenCalledWith(
        '[ironflow] message {"nested":{"deep":"value"}}'
      );
    });
  });
});

describe("createNoopLogger", () => {
  let consoleMocks: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    // Set up fresh spies before each test
    consoleMocks = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should not output anything for any method", () => {
    const logger = createNoopLogger();

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(consoleMocks.debug).not.toHaveBeenCalled();
    expect(consoleMocks.info).not.toHaveBeenCalled();
    expect(consoleMocks.warn).not.toHaveBeenCalled();
    expect(consoleMocks.error).not.toHaveBeenCalled();
  });

  it("should implement Logger interface", () => {
    const logger = createNoopLogger();

    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should accept data parameter without error", () => {
    const logger = createNoopLogger();

    // These should not throw
    expect(() => logger.debug("msg", { key: "value" })).not.toThrow();
    expect(() => logger.info("msg", { key: "value" })).not.toThrow();
    expect(() => logger.warn("msg", { key: "value" })).not.toThrow();
    expect(() => logger.error("msg", { key: "value" })).not.toThrow();
  });
});
