import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '../config/env.js';
import type { Role } from '../generated/prisma/enums.js';
import { ApiError } from './errors.js';

/** Claims embedded in an access token. Never include the password hash or email PII beyond the id. */
export interface AccessTokenPayload {
  sub: string;
  role: Role;
  email: string;
}

/** Shape attached to `req.user` by the `authenticate` middleware. */
export interface AuthenticatedUser {
  id: string;
  role: Role;
  email: string;
}

const signOptions: SignOptions = {
  expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  issuer: env.JWT_ISSUER,
  algorithm: 'HS256',
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: payload.sub, role: payload.role, email: payload.email }, env.JWT_SECRET, signOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'],
    });

    if (typeof decoded === 'string' || !decoded.sub || typeof decoded.sub !== 'string') {
      throw ApiError.unauthorized('Invalid access token');
    }

    const { role, email } = decoded as { role?: unknown; email?: unknown };

    if (typeof role !== 'string' || typeof email !== 'string') {
      throw ApiError.unauthorized('Invalid access token');
    }

    return { sub: decoded.sub, role: role as Role, email };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token has expired');
    }
    throw ApiError.unauthorized('Invalid or malformed access token');
  }
}

/** Extract a bearer token from an Authorization header. */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  const [scheme, token] = headerValue.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return token.trim() || null;
}
