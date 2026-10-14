import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Prisma Client singleton.
 *
 * Prisma ORM 7 requires a driver adapter; `@prisma/adapter-pg` owns the underlying
 * `pg` connection pool. Pool settings are pinned explicitly because the pg driver
 * defaults to *no* connection timeout, which turns an unreachable database into a
 * hung request instead of a fast failure.
 */
const sslConfig =
  env.DATABASE_SSL === 'false'
    ? undefined
    : env.DATABASE_SSL === 'no-verify'
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true };

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.isTest ? 5 : 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  ...(sslConfig ? { ssl: sslConfig } : {}),
});

export const prisma = new PrismaClient({
  adapter,
  log: env.isDevelopment
    ? [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
});

if (env.isDevelopment) {
  prisma.$on('query', (event) => {
    if (event.duration > 100) {
      logger.debug({ durationMs: event.duration, query: event.query }, 'slow query');
    }
  });
}

prisma.$on('warn', (event) => logger.warn({ prisma: event }, 'prisma warning'));
prisma.$on('error', (event) => logger.error({ prisma: event }, 'prisma error'));

/** Probe used by the health endpoint; throws if the database is unreachable. */
export async function checkDatabaseConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

/** Release pooled connections. Called during graceful shutdown. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
