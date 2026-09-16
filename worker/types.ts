export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | Blob): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface R2ObjectBody {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  body: ReadableStream;
  range?: { offset: number; length: number } | { suffix: number };
  writeHttpMetadata(headers: Headers): void;
}

export interface R2ListedObject {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag: string;
}

export interface R2Bucket {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
  get(key: string, options?: { range?: Headers | { offset: number; length: number } | { suffix: number } }): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { limit?: number; cursor?: string; prefix?: string }): Promise<{ objects: R2ListedObject[]; truncated: boolean; cursor?: string }>;
}

export interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  APP_URL: string;
  FILE_API_SECRET: string;
  ADMIN_PASSWORD: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
