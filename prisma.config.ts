import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma ORM 7 configuration.
 *
 * - The datasource URL is configured here (not in schema.prisma) because Prisma 7
 *   removed automatic .env loading and deprecated `url`/`directUrl` in the datasource block.
 * - `env()` from `prisma/config` throws when a variable is missing, which would break
 *   `prisma generate` during `npm install` / Docker builds. We therefore read
 *   `process.env` directly and only forward the values that are actually set.
 *   Commands that really need a database (migrate/studio/db seed) fail later with a
 *   clear connection error if DATABASE_URL is absent.
 */
const databaseUrl = process.env.DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(databaseUrl
    ? {
        datasource: {
          url: databaseUrl,
          ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
        },
      }
    : {}),
});
