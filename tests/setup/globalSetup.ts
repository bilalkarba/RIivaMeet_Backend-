import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TEST_PORT,
  PROJECT_ROOT,
  findFreePort,
  startEmbeddedDatabase,
  type EmbeddedDatabase,
} from '../../scripts/embedded-postgres.js';

/**
 * Test database bootstrap.
 *
 * Requirements: tests must exercise a real PostgreSQL database - no in-memory
 * substitutes, no mocked persistence. Two supported modes:
 *
 *  1. `TEST_DATABASE_URL` is set (CI, staging, a local PostgreSQL/Docker instance):
 *     migrations are applied to that database.
 *  2. `TEST_DATABASE_URL` is not set: a real embedded PostgreSQL cluster is started
 *     on a free local port with its data in `.pgdata/test`, then migrations are
 *     applied. This is what makes `npm test` work on machines without Docker.
 *
 * The resolved URL is handed to the worker processes through `.tmp/vitest-db.json`
 * (read by `setupFiles.ts`) because global setup runs in a different process.
 */

const HANDOFF_FILE = path.join(PROJECT_ROOT, '.tmp', 'vitest-db.json');

/** The Prisma CLI entry point, invoked with the current Node binary (Windows-safe). */
const PRISMA_CLI = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

function applyMigrations(databaseUrl: string): void {
  const prismaEntry = PRISMA_CLI;
  const args = [prismaEntry, 'migrate', 'deploy'];

  execFileSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const explicitUrl = process.env.TEST_DATABASE_URL;
  let embedded: EmbeddedDatabase | null = null;
  let databaseUrl: string;

  if (explicitUrl) {
    databaseUrl = explicitUrl;
    console.log('\n[tests] using TEST_DATABASE_URL (external database)');
  } else {
    const port = await findFreePort(Number(process.env.TEST_PG_PORT ?? DEFAULT_TEST_PORT));
    embedded = await startEmbeddedDatabase({
      dataDir: path.join(PROJECT_ROOT, '.pgdata', 'test'),
      port,
      user: 'coachini',
      password: 'coachini',
      database: 'coachini_test',
      onLog: () => {},
      onError: () => {},
    });
    databaseUrl = embedded.url;
    console.log(`\n[tests] embedded PostgreSQL ready on 127.0.0.1:${embedded.port} (data: .pgdata/test)`);
  }

  mkdirSync(path.dirname(HANDOFF_FILE), { recursive: true });
  writeFileSync(HANDOFF_FILE, JSON.stringify({ url: databaseUrl }), 'utf8');

  try {
    applyMigrations(databaseUrl);
  } catch (error) {
    if (embedded) {
      await embedded.stop();
    }
    throw error;
  }

  console.log('[tests] migrations applied\n');

  return async () => {
    rmSync(HANDOFF_FILE, { force: true });
    if (embedded) {
      await embedded.stop();
    }
  };
}
