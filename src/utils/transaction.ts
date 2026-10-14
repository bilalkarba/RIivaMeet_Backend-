import { Prisma } from '../generated/prisma/client.js';

/**
 * Serializable-transaction helper.
 *
 * Booking creation and booking acceptance both read-then-write, so under plain read
 * committed two concurrent requests can both pass the "no overlapping booking" check
 * and commit. Running those transactions at SERIALIZABLE isolation lets PostgreSQL
 * detect the conflict; we retry the (small, deterministic) transaction a few times
 * and surface a 409 if it still cannot commit.
 */

const SERIALIZATION_FAILURE = 'P2034';
const DEADLOCK_DETECTED = '40P01';

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === SERIALIZATION_FAILURE;
  }
  // Raw driver errors surface as meta.code on some Prisma versions.
  const code = (error as { code?: unknown })?.code;
  return code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE;
}

export interface TransactionRunner {
  <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxAttempts?: number }): Promise<T>;
}

export const runSerializableTransaction: TransactionRunner = async <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxAttempts?: number },
): Promise<T> => {
  const maxAttempts = options?.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Imported lazily to avoid a circular import between prisma.ts and this helper.
      const { prisma } = await import('../config/prisma.js');
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === maxAttempts) {
        throw error;
      }
      // Small backoff to let the conflicting transaction finish.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }

  throw lastError;
};
