/**
 * File storage API type definitions
 *
 * Types for the Ironflow file storage API (buckets, files, signed URLs).
 */

export interface FileBucketConfig {
  maxObjectBytes?: number;
  allowedContentTypes?: string[];
  emitEvents?: boolean;
  allowSignedUrls?: boolean;
}

export interface FileBucketInfo {
  name: string;
  maxObjectBytes: number;
  allowedContentTypes: string[];
  emitEvents: boolean;
  allowSignedUrls: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileInfo {
  bucket: string;
  path: string;
  size: number;
  contentType: string;
  sha256: string;
  etag: string;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ListFilesOptions {
  prefix?: string;
  delimiter?: "/";
  cursor?: string;
  limit?: number;
}

export interface ListFilesResult {
  files: FileInfo[];
  prefixes: string[];
  nextCursor?: string;
}

export interface PutFileOptions {
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

export interface GetFileOptions {
  ifMatch?: string;
  range?: string;
}

export interface FileObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  etag: string;
  size: number | undefined;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface MoveFileOptions {
  toBucket?: string;
  ifMatch?: string;
}

export interface CopyFileOptions {
  toBucket?: string;
}

export interface SignUploadOptions {
  ttlSeconds?: number;
  maxBytes?: number;
  contentType?: string;
  /** The PUT fails with 412 when the path already exists, so the URL cannot overwrite a file. */
  createOnly?: boolean;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}
