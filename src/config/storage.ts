import { env } from './env.js';

/**
 * Object-storage configuration.
 *
 * The API never writes user media to its own disk in production. Instead it hands the
 * client a *presigned* upload URL for an S3-compatible bucket, so the bytes travel
 * straight from the device to the provider.
 *
 * Three providers are supported:
 *
 *  - `none`  (default) - no bucket configured. Upload endpoints answer `503` with a
 *    documented, machine-readable list of the variables that must be set. Text-only
 *    features keep working.
 *  - `s3`    - any S3-compatible provider (AWS S3, Cloudflare R2, DigitalOcean Spaces,
 *    MinIO, Backblaze B2, ...) through official presigned URLs.
 *  - `local` - development/test only. Files are stored under `STORAGE_LOCAL_DIR` and
 *    served by the API. Refused in production so a misconfigured deployment can never
 *    silently fall back to local disk.
 */

export type StorageProviderName = 'none' | 'local' | 's3';

export interface StorageConfig {
  provider: StorageProviderName;
  bucket?: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicBaseUrl?: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  maxUploadBytes: number;
  localDir?: string;
  /** Human-readable explanation of why the provider is unavailable (empty when ready). */
  unavailableReason?: string;
  /** The env variables an operator must set to enable uploads. */
  requiredEnvVars: string[];
}

const LOCAL_DEFAULT_DIR = '.tmp/uploads';

/** Storage is only usable when its provider-specific settings are complete and coherent. */
export function resolveStorageConfig(): StorageConfig {
  const base: StorageConfig = {
    provider: env.STORAGE_PROVIDER,
    region: env.STORAGE_REGION ?? 'us-east-1',
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === 'true',
    signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
    maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    requiredEnvVars: [],
  };

  if (env.STORAGE_PROVIDER === 'none') {
    return {
      ...base,
      requiredEnvVars: [
        'STORAGE_PROVIDER=s3',
        'STORAGE_BUCKET',
        'STORAGE_REGION',
        'STORAGE_ACCESS_KEY_ID',
        'STORAGE_SECRET_ACCESS_KEY',
        'STORAGE_PUBLIC_BASE_URL',
      ],
      unavailableReason:
        'Object storage is not configured. Set STORAGE_PROVIDER=s3 and the STORAGE_* credentials to enable uploads.',
    };
  }

  if (env.STORAGE_PROVIDER === 'local') {
    if (env.isProduction) {
      return {
        ...base,
        requiredEnvVars: ['STORAGE_PROVIDER=s3'],
        unavailableReason:
          'STORAGE_PROVIDER=local is development-only and is refused in production; configure an S3-compatible bucket instead.',
      };
    }
    return {
      ...base,
      localDir: env.STORAGE_LOCAL_DIR ?? LOCAL_DEFAULT_DIR,
      publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    };
  }

  // provider === 's3'
  const missing: string[] = [];
  if (!env.STORAGE_BUCKET) missing.push('STORAGE_BUCKET');
  if (!env.STORAGE_ACCESS_KEY_ID) missing.push('STORAGE_ACCESS_KEY_ID');
  if (!env.STORAGE_SECRET_ACCESS_KEY) missing.push('STORAGE_SECRET_ACCESS_KEY');

  return {
    ...base,
    bucket: env.STORAGE_BUCKET,
    endpoint: env.STORAGE_ENDPOINT,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    requiredEnvVars: missing,
    ...(missing.length > 0
      ? { unavailableReason: `Object storage credentials are incomplete: ${missing.join(', ')}` }
      : {}),
  };
}

/** Frozen process-wide snapshot (tests can re-read it via `resolveStorageConfig`). */
export const storageConfig: StorageConfig = resolveStorageConfig();

export function isStorageAvailable(config: StorageConfig = storageConfig): boolean {
  return config.unavailableReason === undefined;
}
