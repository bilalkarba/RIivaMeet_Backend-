import { z } from 'zod';

import { Role } from '../generated/prisma/enums.js';
import { trimmedString } from './common.schema.js';

/**
 * Public registration may only produce CLIENT or COACH accounts.
 * ADMIN accounts are provisioned out-of-band (seed script / database access), so a
 * client can never escalate its own role through a public endpoint.
 */
export const selfAssignableRole = z.enum([Role.CLIENT, Role.COACH], {
  message: 'role must be either CLIENT or COACH',
});

/** bcrypt only considers the first 72 bytes of a password, so cap the input. */
const MAX_PASSWORD_LENGTH = 72;

/**
 * Emails are trimmed and lower-cased *before* validation so that
 * "  User@Example.com " is accepted and stored as "user@example.com".
 * Uniqueness is enforced on the normalized value by the database index.
 */
const normalizedEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email('Must be a valid email address').max(255),
);

export const registerBodySchema = z
  .object({
    email: normalizedEmailSchema,
    password: z
      .string()
      .min(8, 'password must be at least 8 characters')
      .max(MAX_PASSWORD_LENGTH, `password must be at most ${MAX_PASSWORD_LENGTH} characters`)
      .regex(/[a-zA-Z]/, 'password must contain at least one letter')
      .regex(/[0-9]/, 'password must contain at least one number'),
    name: trimmedString(2, 120),
    phone: z
      .string()
      .trim()
      .min(6, 'phone must be at least 6 characters')
      .max(30, 'phone must be at most 30 characters')
      .regex(/^[+]?[0-9\s().-]+$/, 'phone contains invalid characters')
      .optional(),
    role: selfAssignableRole.default(Role.CLIENT),
  })
  .strict();

export const loginBodySchema = z
  .object({
    email: normalizedEmailSchema,
    password: z.string().min(1, 'password is required').max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
