import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every variable is validated once at process start so the app fails fast with a
 * readable message instead of crashing later with an opaque runtime error.
 * `.env` is loaded here (Prisma ORM 7 no longer loads it automatically).
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (PostgreSQL connection string)'),
  SHADOW_DATABASE_URL: optionalString,
  DATABASE_SSL: z.enum(['false', 'true', 'no-verify']).default('false'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long')
    .refine((value) => !value.startsWith('replace-me'), {
      message: 'JWT_SECRET still holds the placeholder value from .env.example',
    }),
  JWT_EXPIRES_IN: z.string().min(1).default('1h'),
  JWT_ISSUER: z.string().min(1).default('coachini-api'),

  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  FRONTEND_URL: z.string().min(1).default('http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /// Per-user budget for sending chat messages within the window above.
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- Audio / video calls (WebRTC signalling over Socket.IO) ----------------
  /// How long a callee has to answer before the call is marked MISSED.
  CALL_RING_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(45000),
  /// Comma separated STUN server URLs. A public STUN server is enough for most
  /// networks; set STUN_URLS="" to disable. Nothing secret lives here.
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  /// Comma separated TURN server URLs (e.g. "turn:host:3478?transport=udp").
  /// TURN is required for peers behind symmetric NAT; without it, calls still work
  /// whenever a direct connection can be established.
  TURN_URLS: optionalString,
  /// TURN REST API shared secret (coturn `static-auth-secret`, Metered, ...). When set,
  /// the API mints short-lived credentials per request - the secret never reaches the
  /// browser and no long-lived TURN password is ever stored client-side.
  TURN_SHARED_SECRET: optionalString,
  /// Static TURN credentials for providers that do not support the shared-secret
  /// scheme (Twilio, Cloudflare). Kept server-side; only the derived ICE config is sent.
  TURN_USERNAME: optionalString,
  TURN_CREDENTIAL: optionalString,
  /// Lifetime of the minted TURN credentials (also the max age of an ICE config).
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),

  // --- Object storage (avatar / post media) --------------------------------
  // `none` keeps the media endpoints in an explicit "configuration required" state
  // instead of pretending uploads work. `s3` targets any S3-compatible provider
  // (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, ...) through presigned URLs,
  // so the API never proxies or stores the bytes itself.
  STORAGE_PROVIDER: z.enum(['none', 'local', 's3']).default('none'),
  STORAGE_BUCKET: optionalString,
  STORAGE_REGION: optionalString,
  STORAGE_ENDPOINT: optionalString,
  STORAGE_ACCESS_KEY_ID: optionalString,
  STORAGE_SECRET_ACCESS_KEY: optionalString,
  /// Base URL used to build the public object URL (CDN or bucket domain).
  STORAGE_PUBLIC_BASE_URL: optionalString,
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  /// Directory used by the `local` dev-only provider. Never used in production.
  STORAGE_LOCAL_DIR: optionalString,
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const parsed = result.data;

  const corsOrigins = parsed.FRONTEND_URL.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (corsOrigins.length === 0) {
    throw new Error('Invalid environment configuration:\n  - FRONTEND_URL must list at least one origin');
  }

  // Guardrail: a wildcard origin is acceptable while developing, never in production.
  if (parsed.NODE_ENV === 'production' && corsOrigins.includes('*')) {
    throw new Error(
      'Invalid environment configuration:\n  - FRONTEND_URL must not be "*" in production. Set it to your deployed frontend origin(s).',
    );
  }

  // TURN can only be configured one way at a time, and only with credentials.
  if (parsed.TURN_URLS) {
    const hasSharedSecret = Boolean(parsed.TURN_SHARED_SECRET);
    const hasStatic = Boolean(parsed.TURN_USERNAME) && Boolean(parsed.TURN_CREDENTIAL);
    if (!hasSharedSecret && !hasStatic) {
      throw new Error(
        'Invalid environment configuration:\n  - TURN_URLS is set but no credentials were provided. Set TURN_SHARED_SECRET, or both TURN_USERNAME and TURN_CREDENTIAL.',
      );
    }
    if (hasSharedSecret && (parsed.TURN_USERNAME || parsed.TURN_CREDENTIAL)) {
      throw new Error(
        'Invalid environment configuration:\n  - Configure either TURN_SHARED_SECRET or TURN_USERNAME/TURN_CREDENTIAL, not both.',
      );
    }
  } else if (parsed.TURN_SHARED_SECRET || parsed.TURN_USERNAME || parsed.TURN_CREDENTIAL) {
    throw new Error(
      'Invalid environment configuration:\n  - TURN credentials were provided without TURN_URLS. Set TURN_URLS to the TURN server URL(s).',
    );
  }

  return { ...parsed, FRONTEND_URL: corsOrigins.join(',') };
}

const parsedEnv = loadEnv();

export const env = Object.freeze({
  ...parsedEnv,
  /** Comma separated FRONTEND_URL parsed into an explicit allow-list. */
  corsOrigins: Object.freeze(parsedEnv.FRONTEND_URL.split(',')) as readonly string[],
  isProduction: parsedEnv.NODE_ENV === 'production',
  isDevelopment: parsedEnv.NODE_ENV === 'development',
  isTest: parsedEnv.NODE_ENV === 'test',
});

export type AppEnv = typeof env;
