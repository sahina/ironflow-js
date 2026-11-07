import type { FileBucketInfo, FileInfo, ListFilesResult, SignedUrl } from "./files-types.js";
import { timestampFromWire } from "./timestamp-wire.js";

export function fileBucketInfoFromWire(raw: Record<string, unknown>): FileBucketInfo {
  return {
    ...raw,
    createdAt: timestampFromWire("FileBucketInfo.createdAt", raw.createdAt),
    updatedAt: timestampFromWire("FileBucketInfo.updatedAt", raw.updatedAt),
  } as FileBucketInfo;
}

export function fileBucketsFromWire(raw: { buckets: Record<string, unknown>[] }): FileBucketInfo[] {
  return raw.buckets.map(fileBucketInfoFromWire);
}

export function fileInfoFromWire(raw: Record<string, unknown>): FileInfo {
  return {
    ...raw,
    createdAt: timestampFromWire("FileInfo.createdAt", raw.createdAt),
    updatedAt: timestampFromWire("FileInfo.updatedAt", raw.updatedAt),
  } as FileInfo;
}

export function listFilesResultFromWire(raw: { files: Record<string, unknown>[] } & Record<string, unknown>): ListFilesResult {
  return { ...raw, files: raw.files.map(fileInfoFromWire) } as ListFilesResult;
}

export function signedUrlFromWire(raw: Record<string, unknown>): SignedUrl {
  return {
    ...raw,
    expiresAt: timestampFromWire("SignedUrl.expiresAt", raw.expiresAt),
  } as SignedUrl;
}
