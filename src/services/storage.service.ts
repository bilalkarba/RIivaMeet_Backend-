import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../config/env.js';
import { isStorageAvailable, resolveStorageConfig, storageConfig, type StorageConfig } from '../config/storage.js';
import { ApiError } from '../utils/errors.js';

/**
 * Object storage boundary.
 *
 * The API only ever issues *presigned* upload URLs (S3-compatible providers) or, in
 * development, a signed URL pointing back at a dev-only endpoint. Uploaded bytes never
 * transit the API in production and are never written to the application server's disk
 * there.
 *
 * When no provider is configured every media endpoint returns a `503` with
 * `details.requiredEnvVars`, so clients can render a real "storage not configured"
 * state instead of a fake success. Text-only features keep working.
 */

export type MediaKind = 'avatar' | 'post';
export type UploadMethod = 'PUT' | 'POST';

export interface UploadTarget {
  /** Prefixed object key inside the bucket. */
  key: string;
  /** Full public URL to persist once the upload succeeded. */
  publicUrl: string;
  /** URL the client uploads the bytes to. */
  uploadUrl: string;
  method: UploadMethod;
  /** Headers the client must send with the upload (e.g. Content-Type). */
  headers: Record<string, string>;
  /** Unix epoch seconds after which the upload URL is worthless. */
  expiresAt: number;
  maxBytes: number;
}

const ALLOWED_CONTENT_TYPES: Record<MediaKind, readonly string[]> = {
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
  post: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
};

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

export interface StorageStatus {
  configured: boolean;
  provider: StorageConfig['provider'];
  requiredEnvVars: string[];
  reason: string | null;
  maxUploadBytes: number;
  allowedContentTypes: readonly string[];
}

export function getStorageStatus(kind: MediaKind = 'avatar'): StorageStatus {
  const config = resolveStorageConfig();
  const available = isStorageAvailable(config);

  return {
    configured: available,
    provider: config.provider,
    requiredEnvVars: config.requiredEnvVars,
    reason: config.unavailableReason ?? null,
    maxUploadBytes: config.maxUploadBytes,
    allowedContentTypes: ALLOWED_CONTENT_TYPES[kind],
  };
}

/** Throws a documented 503 when uploads cannot be served. */
function requireStorage(config: StorageConfig): StorageConfig {
  if (!isStorageAvailable(config)) {
    throw ApiError.serviceUnavailable(config.unavailableReason ?? 'Object storage is not configured', {
      provider: config.provider,
      requiredEnvVars: config.requiredEnvVars,
    });
  }
  return config;
}

function assertContentTypeAllowed(kind: MediaKind, contentType: string): void {
  if (!ALLOWED_CONTENT_TYPES[kind].includes(contentType)) {
    throw ApiError.badRequest(
      `Unsupported content type "${contentType}" for ${kind}. Allowed: ${ALLOWED_CONTENT_TYPES[kind].join(', ')}`,
      { allowedContentTypes: ALLOWED_CONTENT_TYPES[kind] },
    );
  }
}

function buildObjectKey(kind: MediaKind, ownerUserId: string, contentType: string): string {
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin';
  return `${kind === 'avatar' ? 'avatars' : 'posts'}/${ownerUserId}/${randomUUID()}.${extension}`;
}

/** S3-compatible presigned PUT. Works with AWS S3, R2, Spaces, MinIO, B2, ... */
async function createS3UploadTarget(
  config: StorageConfig,
  kind: MediaKind,
  ownerUserId: string,
  contentType: string,
): Promise<UploadTarget> {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId as string,
      secretAccessKey: config.secretAccessKey as string,
    },
  });

  const key = buildObjectKey(kind, ownerUserId, contentType);
  const expiresIn = config.signedUrlTtlSeconds;

  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );

  return {
    key,
    publicUrl: buildPublicUrl(config, key),
    uploadUrl,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    maxBytes: config.maxUploadBytes,
  };
}

function buildPublicUrl(config: StorageConfig, key: string): string {
  const base =
    config.publicBaseUrl ??
    (config.endpoint ? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}` : undefined) ??
    `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

/** Development/test only: a signed URL pointing back at the dev upload endpoint. */
function createLocalUploadTarget(
  config: StorageConfig,
  kind: MediaKind,
  ownerUserId: string,
  contentType: string,
): UploadTarget {
  const key = buildObjectKey(kind, ownerUserId, contentType);
  const expiresIn = config.signedUrlTtlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const token = signLocalUploadToken(key, expiresAt);
  const base = (config.publicBaseUrl ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');

  return {
    key,
    publicUrl: `${base}/media/${key}`,
    uploadUrl: `${base}${API_STORAGE_PREFIX}/local?key=${encodeURIComponent(key)}&exp=${expiresAt}&token=${token}`,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    expiresAt,
    maxBytes: config.maxUploadBytes,
  };
}

/** Route prefix of the local dev upload endpoint (kept in sync with `storage.routes.ts`). */
export const API_STORAGE_PREFIX = '/api/v1/storage';

export function signLocalUploadToken(key: string, expiresAt: number): string {
  return createHmac('sha256', env.JWT_SECRET).update(`${key}:${expiresAt}`).digest('hex');
}

export function verifyLocalUploadToken(key: string, expiresAt: number, token: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signLocalUploadToken(key, expiresAt);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(token);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Absolute path a local-provider object is written to (dev/test only). */
export function resolveLocalObjectPath(key: string): string {
  const dir = process.cwd();
  const safeKey = key.replace(/\\/g, '/').replace(/\.\.+/g, '');
  return path.join(dir, storageConfig.localDir ?? '.tmp/uploads', safeKey);
}

/**
 * Create an upload target for `kind`. Throws a documented 503 when storage is not
 * configured, and a 400 for unsupported content types.
 */
export async function createUploadTarget(input: {
  kind: MediaKind;
  ownerUserId: string;
  contentType: string;
}): Promise<UploadTarget> {
  // Validate the request before availability so a bad content type is always a 400.
  assertContentTypeAllowed(input.kind, input.contentType);
  const config = requireStorage(resolveStorageConfig());

  if (config.provider === 's3') {
    return createS3UploadTarget(config, input.kind, input.ownerUserId, input.contentType);
  }

  return createLocalUploadTarget(config, input.kind, input.ownerUserId, input.contentType);
}

/** Persist bytes for the dev-only local provider. Refuses anything outside the dev path. */
export async function writeLocalObject(key: string, body: Buffer): Promise<string> {
  const config = requireStorage(resolveStorageConfig());
  if (config.provider !== 'local' || env.isProduction) {
    throw ApiError.forbidden('Direct local uploads are only available in development');
  }
  const isVerificationDocument = key.startsWith(`${DOCUMENT_KEY_PREFIX}/`);
  const maxBytes = isVerificationDocument ? config.documentMaxUploadBytes : config.maxUploadBytes;
  if (body.byteLength > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${maxBytes} bytes`, {
      maxBytes,
    });
  }

  const target = resolveLocalObjectPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return key;
}

const CHAT_ATTACHMENT_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export const CHAT_ATTACHMENT_CONTENT_TYPES = Object.keys(
  CHAT_ATTACHMENT_EXTENSION_BY_CONTENT_TYPE,
);

/** Store a validated chat file under a private, server-generated object key. */
export async function storeChatAttachment(input: {
  conversationId: string;
  contentType: string;
  body: Buffer;
}): Promise<string> {
  const config = requireStorage(resolveStorageConfig());
  if (config.provider === 's3' && !env.STORAGE_DOCUMENT_BUCKET) {
    throw ApiError.serviceUnavailable(
      'Private chat storage is not configured',
      { requiredEnvVars: ['STORAGE_DOCUMENT_BUCKET'] },
    );
  }
  if (!CHAT_ATTACHMENT_EXTENSION_BY_CONTENT_TYPE[input.contentType]) {
    throw ApiError.badRequest('Unsupported chat attachment type');
  }
  if (input.body.byteLength === 0 || input.body.byteLength > config.maxUploadBytes) {
    throw new ApiError(
      input.body.byteLength > config.maxUploadBytes ? 413 : 400,
      input.body.byteLength > config.maxUploadBytes
        ? 'PAYLOAD_TOO_LARGE'
        : 'VALIDATION_ERROR',
      input.body.byteLength > config.maxUploadBytes
        ? `Attachment exceeds ${config.maxUploadBytes} bytes`
        : 'Attachment must not be empty',
      { maxBytes: config.maxUploadBytes },
    );
  }

  const extension = CHAT_ATTACHMENT_EXTENSION_BY_CONTENT_TYPE[input.contentType];
  const key = `chat-attachments/${input.conversationId}/${randomUUID()}.${extension}`;
  if (config.provider === 's3') {
    await createS3Client(config).send(
      new PutObjectCommand({
        Bucket: documentBucketFor(config),
        Key: key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
      }),
    );
    return key;
  }

  const target = resolveLocalObjectPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.body);
  return key;
}

// ---------------------------------------------------------------------------
// Private verification documents
// ---------------------------------------------------------------------------
//
// Coach verification documents (diplomas, certificates) are personal data. They are:
//
//  - stored under a server-generated `verifications/<verificationId>/<uuid>.<ext>` key,
//    so a client-supplied filename can never influence the path (no traversal, no
//    overwrite of another application's file);
//  - restricted to PDF/JPEG/PNG by declared content type, and the real bytes are
//    re-checked against their file signature before the document is accepted;
//  - never given a public URL: they are only ever read through authenticated endpoints
//    (an admin-only stream, see the verification controller).

/** Content types accepted for verification documents. */
export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

const DOCUMENT_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** Key prefix that keeps private documents separate from public media objects. */
export const DOCUMENT_KEY_PREFIX = 'verifications';

/** A stored document whose declared content type is supported. */
export function isAllowedDocumentContentType(contentType: string): boolean {
  return (ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * Detect a document type from its leading bytes ("magic numbers").
 *
 * `declaredContentType` is what the client promised and (for S3) what the presigned
 * signature enforced; this is the independent check that the bytes really are what was
 * declared. Returns `null` when the signature is not recognised.
 */
export function detectDocumentContentType(head: Buffer): string | null {
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return 'application/pdf';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId as string,
      secretAccessKey: config.secretAccessKey as string,
    },
  });
}

/** Bucket that holds verification documents (a dedicated private bucket when configured). */
export function documentBucketFor(config: StorageConfig): string | undefined {
  return config.documentBucket ?? config.bucket;
}

/** Server-generated, collision-free, traversal-safe object key. */
function buildDocumentKey(verificationId: string, contentType: string): string {
  const extension = DOCUMENT_EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin';
  return `${DOCUMENT_KEY_PREFIX}/${verificationId}/${randomUUID()}.${extension}`;
}

export interface DocumentUploadTarget {
  storageProvider: StorageConfig['provider'];
  storageBucket: string | null;
  /** Private object key - never exposed as a URL. */
  key: string;
  uploadUrl: string;
  method: UploadMethod;
  headers: Record<string, string>;
  expiresAt: number;
  maxBytes: number;
}

/**
 * Presigned upload target for one verification document.
 *
 * Signs the `Content-Type` header into the URL, so a client cannot silently upload a
 * different file type through the same link.
 */
export async function createDocumentUploadTarget(input: {
  verificationId: string;
  contentType: string;
}): Promise<DocumentUploadTarget> {
  if (!isAllowedDocumentContentType(input.contentType)) {
    throw ApiError.badRequest(
      `Unsupported document type "${input.contentType}". Allowed: ${ALLOWED_DOCUMENT_CONTENT_TYPES.join(', ')}`,
      { allowedContentTypes: ALLOWED_DOCUMENT_CONTENT_TYPES },
    );
  }

  const config = requireStorage(resolveStorageConfig());
  const key = buildDocumentKey(input.verificationId, input.contentType);
  const expiresIn = config.signedUrlTtlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  if (config.provider === 's3') {
    const client = createS3Client(config);
    const bucket = documentBucketFor(config);
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }),
      { expiresIn },
    );

    return {
      storageProvider: config.provider,
      storageBucket: bucket ?? null,
      key,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt,
      maxBytes: config.documentMaxUploadBytes,
    };
  }

  // Development/test only (`config.provider === 'local'`).
  const token = signLocalUploadToken(key, expiresAt);
  const base = (config.publicBaseUrl ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');

  return {
    storageProvider: config.provider,
    storageBucket: null,
    key,
    uploadUrl: `${base}${API_STORAGE_PREFIX}/local?key=${encodeURIComponent(key)}&exp=${expiresAt}&token=${token}`,
    method: 'PUT',
    headers: { 'Content-Type': input.contentType },
    expiresAt,
    maxBytes: config.documentMaxUploadBytes,
  };
}

export interface ObjectHead {
  sizeBytes: number;
  /** Content type reported by the provider, when it reports one. */
  contentType: string | null;
}

/** Object metadata; throws a safe 404 when the object does not exist. */
export async function headPrivateObject(key: string): Promise<ObjectHead> {
  const config = requireStorage(resolveStorageConfig());

  if (config.provider === 's3') {
    try {
      const head = await createS3Client(config).send(
        new HeadObjectCommand({ Bucket: documentBucketFor(config), Key: key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch {
      // Provider details (including the bucket name) never reach the client.
      throw ApiError.notFound('The uploaded document was not found in storage');
    }
  }

  try {
    const info = await stat(resolveLocalObjectPath(key));
    return { sizeBytes: info.size, contentType: null };
  } catch {
    throw ApiError.notFound('The uploaded document was not found in storage');
  }
}

/** Read the leading bytes of an object (used for file-signature validation). */
export async function readPrivateObjectHeadBytes(key: string, length = 16): Promise<Buffer> {
  const config = requireStorage(resolveStorageConfig());

  if (config.provider === 's3') {
    try {
      const response = await createS3Client(config).send(
        new GetObjectCommand({ Bucket: documentBucketFor(config), Key: key, Range: `bytes=0-${length - 1}` }),
      );
      return Buffer.from((await response.Body?.transformToByteArray()) ?? new Uint8Array());
    } catch {
      throw ApiError.notFound('The uploaded document was not found in storage');
    }
  }

  try {
    const body = await readFile(resolveLocalObjectPath(key));
    return body.subarray(0, length);
  } catch {
    throw ApiError.notFound('The uploaded document was not found in storage');
  }
}

/**
 * Read an object in full, for the authenticated admin download stream and for the AI
 * provider. Never hand the result to a client without an authorization check.
 */
export async function readPrivateObject(key: string): Promise<Buffer> {
  const config = requireStorage(resolveStorageConfig());

  if (config.provider === 's3') {
    try {
      const response = await createS3Client(config).send(
        new GetObjectCommand({ Bucket: documentBucketFor(config), Key: key }),
      );
      return Buffer.from((await response.Body?.transformToByteArray()) ?? new Uint8Array());
    } catch {
      throw ApiError.notFound('The uploaded document was not found in storage');
    }
  }

  try {
    return await readFile(resolveLocalObjectPath(key));
  } catch {
    throw ApiError.notFound('The uploaded document was not found in storage');
  }
}

/** Best-effort object removal (abandoned uploads, replaced/removed documents). */
export async function deletePrivateObject(key: string): Promise<void> {
  const config = resolveStorageConfig();
  if (!isStorageAvailable(config)) {
    return;
  }

  try {
    if (config.provider === 's3') {
      await createS3Client(config).send(
        new DeleteObjectCommand({ Bucket: documentBucketFor(config), Key: key }),
      );
      return;
    }
    await unlink(resolveLocalObjectPath(key));
  } catch {
    // Cleanup is best-effort: an orphaned object must never fail a user-facing request.
  }
}
