import bcrypt from 'bcrypt';

import { env } from '../config/env.js';

/** Hash a plaintext password with bcrypt using the configured cost factor. */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, env.BCRYPT_SALT_ROUNDS);
}

/**
 * Constant-time comparison.
 *
 * Returns false for malformed hashes instead of throwing, so a corrupted row cannot
 * turn into a 500 on the login path.
 */
export async function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plainPassword, passwordHash);
  } catch {
    return false;
  }
}
