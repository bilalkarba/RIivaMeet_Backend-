import path from 'node:path';

import {
  DEFAULT_DEV_PORT,
  PROJECT_ROOT,
  findFreePort,
  isPortFree,
  startEmbeddedDatabase,
} from './embedded-postgres.js';

/**
 * Local development database helper.
 *
 *   npm run db:start    start a real PostgreSQL cluster in the foreground
 *   npm run db:status    check whether it is reachable
 *
 * The cluster keeps its data in `.pgdata/dev`, so stopping (Ctrl+C) and restarting
 * preserves your data. Put the printed URL in `.env` as DATABASE_URL.
 *
 * If you already have PostgreSQL (locally, in Docker, or a managed instance), skip
 * this script entirely and point DATABASE_URL at it.
 */

const DATA_DIR = path.join(PROJECT_ROOT, '.pgdata', 'dev');
const PORT = Number(process.env.EMBEDDED_PG_PORT ?? DEFAULT_DEV_PORT);
const USER = process.env.EMBEDDED_PG_USER ?? 'coachini';
const PASSWORD = process.env.EMBEDDED_PG_PASSWORD ?? 'coachini';
const DATABASE = process.env.EMBEDDED_PG_DATABASE ?? 'coachini';

function printUsage(): void {
  console.log(`
Usage: npm run db:start | npm run db:status

  db:start    Start the local embedded PostgreSQL cluster (foreground, Ctrl+C to stop)
  db:status   Report whether the cluster on port ${PORT} is accepting connections

Environment overrides: EMBEDDED_PG_PORT, EMBEDDED_PG_USER, EMBEDDED_PG_PASSWORD, EMBEDDED_PG_DATABASE
`);
}

async function start(): Promise<void> {
  const portFree = await isPortFree(PORT);
  const port = portFree ? PORT : await findFreePort(PORT + 1);

  if (!portFree) {
    console.log(`Port ${PORT} is in use, starting on ${port} instead.`);
  }

  const database = await startEmbeddedDatabase({
    dataDir: DATA_DIR,
    port,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
    onLog: (message) => {
      if (process.env.EMBEDDED_PG_VERBOSE === 'true') {
        console.log(`[postgres] ${message}`);
      }
    },
    onError: (message) => console.error(`[postgres:error] ${String(message)}`),
  });

  console.log(`
✔ PostgreSQL ${database.url.includes(String(port)) ? '' : ''}is running (data: ${DATA_DIR})

  DATABASE_URL=${database.url}

Next steps (in another terminal):
  npm run migrate:deploy   # apply migrations
  npm run seed             # create sports (+ demo data with SEED_DEMO_DATA=true)
  npm run dev              # start the API on http://localhost:4000

Press Ctrl+C to stop the cluster. Your data stays in ${DATA_DIR}.
`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received - stopping PostgreSQL...`);
    try {
      await database.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function status(): Promise<void> {
  const free = await isPortFree(PORT);
  console.log(
    free
      ? `No PostgreSQL cluster detected on port ${PORT}. Run "npm run db:start".`
      : `✔ PostgreSQL appears to be listening on port ${PORT}.`,
  );
  console.log(`Expected connection string: postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}?schema=public`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'start';

  switch (command) {
    case 'start':
      await start();
      break;
    case 'status':
      await status();
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('Failed to manage the local database:', error instanceof Error ? error.message : error);
  process.exit(1);
});
