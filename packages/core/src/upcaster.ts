import { isRedacted } from "./utils.js";

/**
 * Type for upcaster functions that transform event data from one version to the next.
 */
export type UpcasterFn = (data: unknown) => unknown;

/**
 * Registry for event upcaster functions.
 *
 * Upcasters transform event data from an older schema version to a newer one.
 * They are applied SDK-side when reading events, forming a chain:
 * v1 -> v2 -> v3 (each step applies one upcaster).
 *
 * The chain must be complete -- if v2->v3 is missing, upcasting from v1->v3 throws.
 */
export class UpcasterRegistry {
  private upcasters = new Map<string, Map<number, { toVersion: number; fn: UpcasterFn }>>();

  register(eventName: string, fromVersion: number, toVersion: number, fn: UpcasterFn): void {
    if (!this.upcasters.has(eventName)) {
      this.upcasters.set(eventName, new Map());
    }
    this.upcasters.get(eventName)!.set(fromVersion, { toVersion, fn });
  }

  upcast(eventName: string, data: unknown, fromVersion: number, toVersion: number): unknown {
    if (fromVersion >= toVersion) {
      return data;
    }

    // A redacted payload has no fields left to migrate, and the placeholder's
    // shape does not depend on the schema version. Running the chain over it
    // ranges from useless to destructive: an upcaster that rebuilds the object
    // (`(d) => ({amount: d.amount})`) drops the `$redacted` marker, so every
    // downstream `isRedacted` guard goes blind and the handler folds in
    // `undefined` as if the producer had sent it. One that reaches through a
    // nested field throws a TypeError out of the ExecutionContext constructor,
    // which serve() reports as a 500 the engine then retries to exhaustion.
    // Pass it through untouched and let the reducer or handler see the marker.
    if (isRedacted(data)) {
      return data;
    }

    let currentData = data;
    let currentVersion = fromVersion;
    const eventUpcasters = this.upcasters.get(eventName);

    while (currentVersion < toVersion) {
      const upcaster = eventUpcasters?.get(currentVersion);
      if (!upcaster) {
        throw new Error(
          `Incomplete upcaster chain for "${eventName}": no upcaster from v${currentVersion} to v${currentVersion + 1} ` +
          `(chain broken at v${currentVersion}, target v${toVersion})`
        );
      }
      currentData = upcaster.fn(currentData);
      currentVersion = upcaster.toVersion;
    }

    return currentData;
  }

  getLatestVersion(eventName: string): number | undefined {
    const eventUpcasters = this.upcasters.get(eventName);
    if (!eventUpcasters || eventUpcasters.size === 0) {
      return undefined;
    }

    let maxVersion = 0;
    for (const [fromVersion, { toVersion }] of eventUpcasters) {
      maxVersion = Math.max(maxVersion, fromVersion, toVersion);
    }
    return maxVersion;
  }
}

export function createUpcasterRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
