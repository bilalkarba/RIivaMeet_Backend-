import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs in every test worker *before* the test file (and therefore before any
 * application module) is imported. This is what makes `env.ts` see a valid
 * configuration when the app is loaded.
 *
 * Values are only defaulted (`??=`) so an explicit environment - e.g. a CI job that
 * exports TEST_DATABASE_URL - always wins.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-value-0123456789abcdef';
process.env.JWT_EXPIRES_IN ??= '1h';
process.env.JWT_ISSUER ??= 'coachini-api-test';
// Keep bcrypt fast in tests while staying above the allowed minimum.
process.env.BCRYPT_SALT_ROUNDS ??= '4';
process.env.FRONTEND_URL ??= 'http://localhost:3000';
// Effectively disable rate limiting so suites are not throttled.
process.env.RATE_LIMIT_WINDOW_MS ??= '60000';
process.env.RATE_LIMIT_MAX ??= '1000000';
process.env.AUTH_RATE_LIMIT_MAX ??= '1000000';
process.env.DATABASE_SSL ??= 'false';
process.env.TRUST_PROXY ??= '0';
// Keep the ring timeout short so the "missed call" path is testable in seconds.
// 5000 is the minimum accepted by the env schema.
process.env.CALL_RING_TIMEOUT_MS ??= '5000';

const handoffFile = path.join(projectRoot, '.tmp', 'vitest-db.json');
const handoff = JSON.parse(readFileSync(handoffFile, 'utf8')) as { url: string };

if (!handoff.url) {
  throw new Error('Test database URL missing from .tmp/vitest-db.json - did globalSetup run?');
}

process.env.DATABASE_URL = handoff.url;
