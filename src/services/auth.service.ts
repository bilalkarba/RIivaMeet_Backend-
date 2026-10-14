import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/errors.js';
import { signAccessToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';
import { toPublicUser, type AuthResponse, type PublicUser } from '../utils/presenters.js';
import type { LoginBody, RegisterBody } from '../schemas/auth.schema.js';

/**
 * Authentication service.
 *
 * Emails are normalized (trimmed + lower-cased) before every write and lookup so
 * "User@Example.com" and "user@example.com" are the same account. Uniqueness is
 * guaranteed by the database index; the pre-check only exists to produce a nicer
 * message, and the insert race is caught as well.
 */

/**
 * A real bcrypt hash used to burn the same CPU time when the email does not exist,
 * so login cannot be used to enumerate accounts through timing differences.
 */
let dummyPasswordHash: string | null = null;

async function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= await hashPassword('__coachini_timing_placeholder__');
  return dummyPasswordHash;
}

export async function registerUser(input: RegisterBody): Promise<AuthResponse> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existing) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        phone: input.phone ?? null,
        role: input.role,
      },
    });

    return buildAuthResponse(user, false);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw ApiError.conflict('An account with this email already exists');
    }
    throw error;
  }
}

export async function loginUser(input: LoginBody): Promise<AuthResponse> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { coachProfile: { select: { id: true } } },
  });

  if (!user) {
    // Equalize response time between "unknown email" and "wrong password".
    await verifyPassword(input.password, await getDummyPasswordHash());
    throw ApiError.invalidCredentials();
  }

  const passwordMatches = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw ApiError.invalidCredentials();
  }

  return buildAuthResponse(user, Boolean(user.coachProfile));
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { coachProfile: { select: { id: true } } },
  });

  if (!user) {
    // Token is valid but the account is gone (deleted meanwhile).
    throw ApiError.unauthorized('Account no longer exists');
  }

  return toPublicUser(user, { hasCoachProfile: Boolean(user.coachProfile) });
}

function buildAuthResponse(
  user: {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    role: AuthResponse['user']['role'];
    createdAt: Date;
    updatedAt: Date;
  },
  hasCoachProfile: boolean,
): AuthResponse {
  return {
    user: toPublicUser(user, { hasCoachProfile }),
    accessToken: signAccessToken({ sub: user.id, role: user.role, email: user.email }),
    tokenType: 'Bearer',
    expiresIn: env.JWT_EXPIRES_IN,
  };
}
