/**
 * Utility functions for Ironflow SDK
 */

/**
 * Parse a duration string into milliseconds.
 *
 * Supported formats:
 * - "1s", "30s" - seconds
 * - "1m", "30m" - minutes
 * - "1h", "12h" - hours
 * - "1d", "7d" - days
 * - 1000 (number) - milliseconds
 *
 * @param duration - Duration string or number in milliseconds
 * @returns Duration in milliseconds
 * @throws Error if format is invalid
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === "number") {
    return duration;
  }

  const match = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${duration}". Use format like "30s", "5m", "2h", "7d" or number of milliseconds.`
    );
  }

  const value = parseFloat(match[1]!);
  const unit = match[2]!;

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Math.floor(value * multipliers[unit]!);
}

/**
 * Calculate exponential backoff delay
 *
 * @param attempt - Current attempt number (1-based)
 * @param initialDelay - Initial delay in milliseconds
 * @param maxDelay - Maximum delay in milliseconds
 * @param multiplier - Backoff multiplier (default: 2)
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number = 2
): number {
  const delay = initialDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Sleep for a given duration
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Safely parse JSON, returning undefined on error
 */
export function safeJsonParse(data: string): unknown | undefined {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * Type guard to check if a value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (isObject(sourceValue) && isObject(targetValue)) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}
