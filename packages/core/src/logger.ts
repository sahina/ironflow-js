/**
 * Logger utilities for Ironflow SDK
 */

import type { Logger } from "./types.js";

/**
 * Log level enumeration
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;
  /** Prefix for log messages */
  prefix?: string;
}

/**
 * Log level priorities for filtering
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Create a logger instance
 */
export function createLogger(config?: LoggerConfig): Logger {
  const level = config?.level ?? getDefaultLogLevel();
  const prefix = config?.prefix ?? "[ironflow]";
  const minLevel = LOG_LEVELS[level];

  const shouldLog = (logLevel: LogLevel) => LOG_LEVELS[logLevel] >= minLevel;

  const formatMessage = (message: string) => `${prefix} ${message}`;

  const formatData = (data?: Record<string, unknown>) => {
    if (!data) return "";
    return " " + JSON.stringify(data);
  };

  return {
    debug(message: string, data?: Record<string, unknown>) {
      if (shouldLog("debug")) {
        // eslint-disable-next-line no-console
        console.debug(formatMessage(message) + formatData(data));
      }
    },
    info(message: string, data?: Record<string, unknown>) {
      if (shouldLog("info")) {
        // eslint-disable-next-line no-console
        console.info(formatMessage(message) + formatData(data));
      }
    },
    warn(message: string, data?: Record<string, unknown>) {
      if (shouldLog("warn")) {
        // eslint-disable-next-line no-console
        console.warn(formatMessage(message) + formatData(data));
      }
    },
    error(message: string, data?: Record<string, unknown>) {
      if (shouldLog("error")) {
        // eslint-disable-next-line no-console
        console.error(formatMessage(message) + formatData(data));
      }
    },
  };
}

/**
 * Create a no-op logger that doesn't output anything
 */
export function createNoopLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Get the default log level from environment
 */
function getDefaultLogLevel(): LogLevel {
  if (typeof process !== "undefined" && process.env?.["IRONFLOW_LOG_LEVEL"]) {
    const level = process.env["IRONFLOW_LOG_LEVEL"].toLowerCase();
    if (level in LOG_LEVELS) {
      return level as LogLevel;
    }
  }
  return "info";
}
