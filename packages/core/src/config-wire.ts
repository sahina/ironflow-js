import type { ConfigEntry, ConfigResponse, ConfigWatchEvent } from "./config-types.js";
import { timestampFromWire } from "./timestamp-wire.js";

export function configResponseFromWire(raw: Record<string, unknown>): ConfigResponse {
  return {
    ...raw,
    updatedAt: timestampFromWire("ConfigResponse.updatedAt", raw.updatedAt),
  } as ConfigResponse;
}

function configEntryFromWire(raw: Record<string, unknown>): ConfigEntry {
  return {
    ...raw,
    updatedAt: timestampFromWire("ConfigEntry.updatedAt", raw.updatedAt),
  } as ConfigEntry;
}

export function configEntriesFromWire(raw: { configs: Record<string, unknown>[] }): ConfigEntry[] {
  return raw.configs.map(configEntryFromWire);
}

/** Throws on an unreadable value. A socket callback must catch it and route it to `onError`. */
export function configWatchEventFromWire(raw: Record<string, unknown>): ConfigWatchEvent {
  return {
    ...raw,
    updatedAt: timestampFromWire("ConfigWatchEvent.updatedAt", raw.updatedAt),
  } as ConfigWatchEvent;
}
