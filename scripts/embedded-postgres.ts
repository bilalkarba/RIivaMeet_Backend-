import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

/**
 * Real PostgreSQL, without Docker.
 *
 * `docker`/`psql` are not available in every development environment, but the API
 * (and its tests) must run against genuine PostgreSQL - never an in-memory or mocked
 * database. `embedded-postgres` ships the official PostgreSQL binaries as a
 * dev-only dependency and manages a real cluster on disk, so:
 *
 *   - `npm run db:start` gives local development a persistent cluster (.pgdata/dev)
 *   - the test suite starts its own cluster (.pgdata/test) when TEST_DATABASE_URL
 *     is not set, and uses your real database when it is (CI/staging).
 *
 * Nothing here is used in production: production always connects to DATABASE_URL.
 */

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DATABASE = 'coachini';
export const DEFAULT_USER = 'coachini';
export const DEFAULT_PASSWORD = 'coachini';
export const DEFAULT_DEV_PORT = 55432;
export const DEFAULT_TEST_PORT = 55433;

export interface StartEmbeddedDatabaseOptions {
  /** Directory that holds the PostgreSQL data files. Created when missing. */
  dataDir: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  onLog?: (message: string) => void;
  onError?: (messageOrError: unknown) => void;
}

export interface EmbeddedDatabase {
  url: string;
  port: number;
  dataDir: string;
  database: string;
  stop: () => Promise<void>;
}

/** Useful when a fixed port is already taken by a leftover cluster. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(startPort: number, maxTries = 50): Promise<number> {
  for (let offset = 0; offset < maxTries; offset += 1) {
    const candidate = startPort + offset;
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No free TCP port found in range ${startPort}-${startPort + maxTries - 1}`);
}

/**
 * Initialise (when needed), start, and expose a running PostgreSQL cluster.
 * The returned `url` is a ready-to-use DATABASE_URL.
 */
export async function startEmbeddedDatabase(options: StartEmbeddedDatabaseOptions): Promise<EmbeddedDatabase> {
  const user = options.user ?? DEFAULT_USER;
  const password = options.password ?? DEFAULT_PASSWORD;
  const database = options.database ?? DEFAULT_DATABASE;
  const dataDir = path.resolve(options.dataDir);

  await mkdir(dataDir, { recursive: true });

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: options.port,
    user,
    password,
    persistent: true,
    // Keep the cluster on the loopback interface only.
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: options.onLog ?? (() => {}),
    onError: options.onError ?? (() => {}),
  });

  await initialiseIfNeeded(instance, dataDir);
  await instance.start();

  // `createDatabase` throws when the database already exists (persistent dirs).
  try {
    await instance.createDatabase(database);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }

  const url = `postgresql://${user}:${password}@127.0.0.1:${options.port}/${database}?schema=public`;

  return {
    url,
    port: options.port,
    dataDir,
    database,
    stop: async () => {
      await instance.stop();
    },
  };
}

async function initialiseIfNeeded(instance: EmbeddedPostgres, dataDir: string): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[] = [];

  try {
    entries = await readdir(dataDir);
  } catch {
    entries = [];
  }

  // A data directory containing PG_VERSION has already been initialised.
  if (!entries.includes('PG_VERSION')) {
    await instance.initialise();
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate database/i.test(message);
}
