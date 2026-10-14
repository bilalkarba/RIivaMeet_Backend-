import { prisma } from '../../src/config/prisma.js';
import { seedSports } from '../../prisma/seed.js';

/**
 * Wipe every table and restore the sport catalogue.
 *
 * Tests share one PostgreSQL database, so each test starts from a known state.
 * CASCADE handles the foreign keys; RESTART IDENTITY keeps primary keys predictable.
 * The statement contains no user input (hence the `Unsafe` variant is safe here).
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "calls", "messages", "conversation_participants", "conversations", "reports", "blocks", "reviews", "notifications", "bookings", "availabilities", "coach_sports", "user_sports", "coach_profiles", "sports", "users" RESTART IDENTITY CASCADE',
  );
  await seedSports(prisma);
}

/** Disconnect the shared client - used by suites that need a clean teardown. */
export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
