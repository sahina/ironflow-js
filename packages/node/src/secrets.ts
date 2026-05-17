import type { SecretsClient } from "@ironflow/core";

/**
 * Creates a read-only SecretsClient from a resolved secrets map.
 */
export function createSecretsClient(
  secrets?: Record<string, string>
): SecretsClient {
  const values = secrets ?? {};
  return {
    get(name: string): string {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`Secret "${name}" not found`);
      }
      return value;
    },
    has(name: string): boolean {
      return name in values;
    },
  };
}
