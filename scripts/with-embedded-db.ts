import { spawn } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_DEV_PORT, PROJECT_ROOT, findFreePort, startEmbeddedDatabase } from './embedded-postgres.js';

/**
 * Run any command against a throwaway-but-persistent embedded PostgreSQL cluster.
 *
 *   npm run migrate:dev     -> tsx scripts/with-embedded-db.ts -- prisma migrate dev
 *   npm run seed:local      -> tsx scripts/with-embedded-db.ts -- prisma db seed
 *
 * The cluster starts on a free local port with its data in `.pgdata/dev`, the child
 * process receives a ready-made DATABASE_URL, and the cluster is shut down when the
 * command finishes. Use this when you have neither Docker nor a local PostgreSQL.
 *
 * If DATABASE_URL is already exported, the command runs against that database and no
 * embedded cluster is started.
 */

const DATA_DIR = path.join(PROJECT_ROOT, '.pgdata', 'dev');
const PREFERRED_PORT = Number(process.env.EMBEDDED_PG_PORT ?? DEFAULT_DEV_PORT);

function parseCommand(): string[] {
  const separator = process.argv.indexOf('--');
  const command = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);

  if (command.length === 0) {
    console.error('Usage: tsx scripts/with-embedded-db.ts -- <command> [args...]');
    process.exit(1);
  }

  return command;
}

function runCommand(command: string[], databaseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.join(' '), {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: process.env.NODE_ENV ?? 'development' },
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const command = parseCommand();

  if (process.env.DATABASE_URL) {
    console.log('DATABASE_URL is set - running the command against the configured database.');
    process.exitCode = await runCommand(command, process.env.DATABASE_URL);
    return;
  }

  const port = await findFreePort(PREFERRED_PORT);
  console.log(`Starting embedded PostgreSQL on port ${port} (data: ${DATA_DIR})...`);

  const database = await startEmbeddedDatabase({
    dataDir: DATA_DIR,
    port,
    user: process.env.EMBEDDED_PG_USER ?? 'coachini',
    password: process.env.EMBEDDED_PG_PASSWORD ?? 'coachini',
    database: process.env.EMBEDDED_PG_DATABASE ?? 'coachini',
    onError: (message) => console.error(`[postgres:error] ${String(message)}`),
  });

  try {
    process.exitCode = await runCommand(command, database.url);
  } finally {
    await database.stop();
    console.log('Embedded PostgreSQL stopped.');
  }
}

main().catch((error: unknown) => {
  console.error('Command failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
