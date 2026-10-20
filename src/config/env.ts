import "dotenv/config";
import { z } from "zod";

/**
 * Environment configuration.
 *
 * Every variable is validated once at process start so the app fails fast with a
 * readable message instead of crashing later with an opaque runtime error.
 * `.env` is loaded here (Prisma ORM 7 no longer loads it automatically).
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional(),
);

/**
 * Document kinds a verification application can hold. Mirrors the
 * `VerificationDocumentType` Prisma enum; used to validate the configurable requirement.
 */
export const VERIFICATION_DOCUMENT_TYPES = [
  "DIPLOMA",
  "CERTIFICATION",
  "OTHER",
] as const;
export type VerificationDocumentTypeName =
  (typeof VERIFICATION_DOCUMENT_TYPES)[number];

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (PostgreSQL connection string)"),
  SHADOW_DATABASE_URL: optionalString,
  DATABASE_SSL: z.enum(["false", "true", "no-verify"]).default("false"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters long")
    .refine((value) => !value.startsWith("replace-me"), {
      message: "JWT_SECRET still holds the placeholder value from .env.example",
    }),
  JWT_EXPIRES_IN: z.string().min(1).default("1h"),
  JWT_ISSUER: z.string().min(1).default("coachini-api"),

  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  FRONTEND_URL: z.string().min(1).default("http://localhost:4200/"),

  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /// Per-user budget for sending chat messages within the window above.
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  // --- Message moderation (off-platform contact sharing) -------------------
  /// Master switch. Kept explicit so an operator can disable the check without a deploy.
  MESSAGE_MODERATION_ENABLED: z.enum(["true", "false"]).default("true"),
  /// What happens when a message contains contact details:
  ///  warn  - persist and deliver the message, return a warning to the sender
  ///  block - reject the message before it is persisted or broadcast
  ///  flag  - persist and deliver it, and record it for administrator review
  /// Defaults to block so contact details are not shared unless an operator explicitly opts in.
  MESSAGE_MODERATION_POLICY: z.enum(["warn", "block", "flag"]).default("block"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // --- Audio / video calls (WebRTC signalling over Socket.IO) ----------------
  /// How long a callee has to answer before the call is marked MISSED.
  CALL_RING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .max(120000)
    .default(45000),
  /// Grace period after the last socket disconnects before the server ends an active
  /// call. Covers tab changes, Wi-Fi handovers and short network drops. 0 = no grace
  /// (the call ends as soon as the user has no sockets left).
  CALL_DISCONNECT_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120000)
    .default(15000),
  /// Hard ceiling for a connected call, so a crashed browser cannot leave a session
  /// RINGING/ACCEPTED forever. The periodic sweep and boot reconciliation use it.
  CALL_MAX_DURATION_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(240),
  /// Maximum call invitations a user may send per rate-limit window.
  CALL_INVITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /// Maximum signalling frames (SDP/ICE) a user may relay per window. ICE trickling is
  /// chatty, so this is intentionally much higher than the chat limit.
  CALL_SIGNAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  CALL_SIGNAL_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  /// Comma separated STUN server URLs. A public STUN server is enough for most
  /// networks; set STUN_URLS="" to disable. Nothing secret lives here.
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
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
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(3600),

  // --- Object storage (avatar / post media) --------------------------------
  // `none` keeps the media endpoints in an explicit "configuration required" state
  // instead of pretending uploads work. `s3` targets any S3-compatible provider
  // (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, ...) through presigned URLs,
  // so the API never proxies or stores the bytes itself.
  STORAGE_PROVIDER: z.enum(["none", "local", "s3"]).default("none"),
  STORAGE_BUCKET: optionalString,
  STORAGE_REGION: optionalString,
  STORAGE_ENDPOINT: optionalString,
  STORAGE_ACCESS_KEY_ID: optionalString,
  STORAGE_SECRET_ACCESS_KEY: optionalString,
  /// Base URL used to build the public object URL (CDN or bucket domain).
  STORAGE_PUBLIC_BASE_URL: optionalString,
  STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(300),
  STORAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  /// Directory used by the `local` dev-only provider. Never used in production.
  STORAGE_LOCAL_DIR: optionalString,

  // --- Coach verification: private document storage ------------------------
  // Verification documents (diplomas, certificates) reuse the STORAGE_* provider but
  // never get a public URL: they live under the `verifications/` key prefix and are only
  // ever read through authenticated endpoints (streamed by the API).
  /// Maximum size of one verification document. Default 10 MB.
  STORAGE_DOCUMENT_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /// Optional dedicated (private) bucket for verification documents. Falls back to STORAGE_BUCKET.
  STORAGE_DOCUMENT_BUCKET: optionalString,

  /// Comma-separated document types required to submit an application. Empty = any one
  /// document. Defaults to "a diploma or a professional certificate" (no identity papers).
  VERIFICATION_REQUIRED_DOCUMENT_TYPES: z
    .string()
    .default("DIPLOMA,CERTIFICATION"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const parsed = result.data;

  const configuredCorsOrigins = parsed.FRONTEND_URL.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (configuredCorsOrigins.length === 0) {
    throw new Error(
      "Invalid environment configuration:\n  - FRONTEND_URL must list at least one origin",
    );
  }

  const corsOrigins = configuredCorsOrigins.map((origin) => {
    if (origin === "*") {
      return origin;
    }

    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        `Invalid environment configuration:\n  - FRONTEND_URL contains an invalid URL: ${origin}`,
      );
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `Invalid environment configuration:\n  - FRONTEND_URL must contain HTTP(S) origins: ${origin}`,
      );
    }

    return url.origin;
  });

  // Guardrail: a wildcard origin is acceptable while developing, never in production.
  if (parsed.NODE_ENV === "production" && corsOrigins.includes("*")) {
    throw new Error(
      'Invalid environment configuration:\n  - FRONTEND_URL must not be "*" in production. Set it to your deployed frontend origin(s).',
    );
  }

  // TURN can only be configured one way at a time, and only with credentials.
  if (parsed.TURN_URLS) {
    const hasSharedSecret = Boolean(parsed.TURN_SHARED_SECRET);
    const hasStatic =
      Boolean(parsed.TURN_USERNAME) && Boolean(parsed.TURN_CREDENTIAL);
    if (!hasSharedSecret && !hasStatic) {
      throw new Error(
        "Invalid environment configuration:\n  - TURN_URLS is set but no credentials were provided. Set TURN_SHARED_SECRET, or both TURN_USERNAME and TURN_CREDENTIAL.",
      );
    }
    if (hasSharedSecret && (parsed.TURN_USERNAME || parsed.TURN_CREDENTIAL)) {
      throw new Error(
        "Invalid environment configuration:\n  - Configure either TURN_SHARED_SECRET or TURN_USERNAME/TURN_CREDENTIAL, not both.",
      );
    }
  } else if (
    parsed.TURN_SHARED_SECRET ||
    parsed.TURN_USERNAME ||
    parsed.TURN_CREDENTIAL
  ) {
    throw new Error(
      "Invalid environment configuration:\n  - TURN credentials were provided without TURN_URLS. Set TURN_URLS to the TURN server URL(s).",
    );
  }

  // Coach verification guardrails.
  const requiredDocumentTypes =
    parsed.VERIFICATION_REQUIRED_DOCUMENT_TYPES.split(",")
      .map((type) => type.trim().toUpperCase())
      .filter((type) => type.length > 0);

  const invalidDocumentTypes = requiredDocumentTypes.filter(
    (type) =>
      !(VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(type),
  );
  if (invalidDocumentTypes.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n  - VERIFICATION_REQUIRED_DOCUMENT_TYPES contains unknown value(s): ${invalidDocumentTypes.join(", ")}. Allowed: ${VERIFICATION_DOCUMENT_TYPES.join(", ")}`,
    );
  }

  return {
    ...parsed,
    FRONTEND_URL: corsOrigins.join(","),
    VERIFICATION_REQUIRED_DOCUMENT_TYPES: requiredDocumentTypes.join(","),
  };
}

const parsedEnv = loadEnv();

export const env = Object.freeze({
  ...parsedEnv,
  /** Comma separated FRONTEND_URL parsed into an explicit allow-list. */
  corsOrigins: Object.freeze(
    parsedEnv.FRONTEND_URL.split(","),
  ) as readonly string[],
  /** Types that satisfy the document requirement of a verification submission. */
  verificationRequiredDocumentTypes: Object.freeze(
    parsedEnv.VERIFICATION_REQUIRED_DOCUMENT_TYPES.split(",").filter(
      (type) => type.length > 0,
    ),
  ) as readonly VerificationDocumentTypeName[],
  isProduction: parsedEnv.NODE_ENV === "production",
  isDevelopment: parsedEnv.NODE_ENV === "development",
  isTest: parsedEnv.NODE_ENV === "test",
});

export type AppEnv = typeof env;
