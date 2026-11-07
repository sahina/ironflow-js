import type { KVBucketInfo, KVEntry } from "./kv-types.js";
import { timestampFromWire } from "./timestamp-wire.js";

export function kvBucketInfoFromWire(raw: Record<string, unknown>): KVBucketInfo {
  return {
    ...raw,
    created_at: timestampFromWire("KVBucketInfo.created_at", raw.created_at),
  } as KVBucketInfo;
}

export function kvBucketsFromWire(raw: { buckets: Record<string, unknown>[] }): KVBucketInfo[] {
  return raw.buckets.map(kvBucketInfoFromWire);
}

export function kvEntryFromWire(raw: Record<string, unknown>): KVEntry {
  return {
    ...raw,
    created_at: timestampFromWire("KVEntry.created_at", raw.created_at),
  } as KVEntry;
}
