import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  if (body.byteLength > config.maxUploadBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${config.maxUploadBytes} bytes`, {
      maxBytes: config.maxUploadBytes,
    });
  }

  const target = resolveLocalObjectPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return key;
}
