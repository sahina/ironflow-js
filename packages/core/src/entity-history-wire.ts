import { IronflowError, ValidationError } from "./errors.js";
import type { EntityHistoryEntry, EntityHistoryOptions } from "./types.js";

/** One GetEntityHistory page as ProtoJSON encodes it. */
export interface EntityHistoryPageWire {
  entries?: Array<Record<string, unknown>>;
  nextCursor?: string | number;
}

/** Events per request; the server default is 50, so a long history needs many fewer round trips. */
export const ENTITY_HISTORY_PAGE_SIZE = 500;

// A string bound goes on the wire unchanged: toISOString() cuts it to
// milliseconds, and stored timestamps carry nanoseconds, so an inclusive `to`
// copied from an entry's timestamp would drop that entry.
function wireTimestamp(name: string, value: Date | string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError(`${name} is an invalid Date`);
    return value.toISOString();
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${name} must be an RFC 3339 timestamp, got "${value}"`);
  }
  return value;
}

/**
 * Follow GetEntityHistory's page cursor until the history (or `options.limit`
 * entries) is complete. `fetchPage` sends one request body and returns the
 * decoded response, so each client keeps its own transport.
 */
export async function collectEntityHistory(
  fetchPage: (body: Record<string, unknown>) => Promise<EntityHistoryPageWire>,
  entityId: string,
  options: EntityHistoryOptions = {},
): Promise<EntityHistoryEntry[]> {
  const max = options.limit ?? Infinity;
  if (max < 0) throw new ValidationError("limit must be nonnegative");
  const fromTimestamp = wireTimestamp("from", options.from);
  const toTimestamp = wireTimestamp("to", options.to);
  const entries: EntityHistoryEntry[] = [];
  let fromVersion = options.fromVersion ?? 0;
  while (entries.length < max) {
    const page = await fetchPage({
      entityId,
      fromVersion,
      limit: Math.min(ENTITY_HISTORY_PAGE_SIZE, max - entries.length),
      fromTimestamp,
      toTimestamp,
    });
    for (const entry of page.entries ?? []) {
      entries.push({
        eventName: String(entry.eventName ?? ""),
        data: Object.hasOwn(entry, "eventDataValue") ? entry.eventDataValue : entry.eventData,
        version: Number(entry.entityVersion ?? 0),
        timestamp: String(entry.timestamp ?? ""),
      });
    }
    const next = Number(page.nextCursor ?? 0);
    if (next === 0) break;
    if (next <= fromVersion) {
      throw new IronflowError(`GetEntityHistory cursor did not advance (from ${fromVersion} to ${next})`);
    }
    fromVersion = next;
  }
  return entries;
}
