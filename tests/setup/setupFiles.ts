import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs in every test worker *before* the test file (and therefore before any
 * application module) is imported. This is what makes `env.ts` see a valid
 * configuration when the app is loaded.
 *
 * Values are only defaulted (`??=`) so an explicit environment - e.g. a CI job that
 * exports TEST_DATABASE_URL - always wins.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.JWT_SECRET ??= "test-only-jwt-secret-value-0123456789abcdef";
process.env.JWT_EXPIRES_IN ??= "1h";
process.env.JWT_ISSUER ??= "coachini-api-test";
// Keep bcrypt fast in tests while staying above the allowed minimum.
process.env.BCRYPT_SALT_ROUNDS ??= "4";
process.env.FRONTEND_URL ??= "http://localhost:4200/";
// Effectively disable rate limiting so suites are not throttled.
process.env.RATE_LIMIT_WINDOW_MS ??= "60000";
process.env.RATE_LIMIT_MAX ??= "1000000";
process.env.AUTH_RATE_LIMIT_MAX ??= "1000000";
process.env.DATABASE_SSL ??= "false";
process.env.TRUST_PROXY ??= "0";
// Storage tests assert the documented "not configured" state; keep the suite hermetic even
// when the developer's .env uses the local/S3 provider. Suites that need another provider
// set it explicitly before importing the app (see storage-local / verification tests).
process.env.STORAGE_PROVIDER ??= "none";
// Keep the ring timeout short so the "missed call" path is testable in seconds.
// 5000 is the minimum accepted by the env schema.
process.env.CALL_RING_TIMEOUT_MS ??= "5000";
// Short enough to test the disconnect grace without slowing the suite down.
process.env.CALL_DISCONNECT_GRACE_MS ??= "1000";
process.env.CALL_MAX_DURATION_MINUTES ??= "240";
// Socket rate limits must not throttle the tests.
process.env.CALL_INVITE_RATE_LIMIT_MAX ??= "100000";
process.env.CALL_SIGNAL_RATE_LIMIT_MAX ??= "100000";
// Contact sharing is blocked by default; unit tests pass explicit policy variants.
process.env.MESSAGE_MODERATION_ENABLED ??= "true";
process.env.MESSAGE_MODERATION_POLICY ??= "block";

const handoffFile = path.join(projectRoot, ".tmp", "vitest-db.json");
const handoff = JSON.parse(readFileSync(handoffFile, "utf8")) as {
  url: string;
};

if (!handoff.url) {
  throw new Error(
    "Test database URL missing from .tmp/vitest-db.json - did globalSetup run?",
  );
}

process.env.DATABASE_URL = handoff.url;
