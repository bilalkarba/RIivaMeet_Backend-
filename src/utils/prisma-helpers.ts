import { Prisma } from '../generated/prisma/client.js';

/**
 * True when the failure is a unique-constraint violation (PostgreSQL 23505).
 *
 * Services use this to convert "check then insert" races into deterministic 409s,
 * because the database - not the pre-check - is the source of truth.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  return (error as { code?: unknown })?.code === 'P2002';
}

/** True for "record to update/delete does not exist" (P2025). */
export function isRecordNotFoundError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2025';
  }
  return (error as { code?: unknown })?.code === 'P2025';
}
