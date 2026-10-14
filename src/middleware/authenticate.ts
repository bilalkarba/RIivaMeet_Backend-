import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ApiError } from '../utils/errors.js';
import { extractBearerToken, verifyAccessToken } from '../utils/jwt.js';

/**
 * JWT access-token authentication.
 *
 * Verifies signature, issuer and expiry, then attaches `{ id, role, email }` to
 * `req.user`. Stateless by design: no database round-trip per request. Role changes
 * therefore take effect on the next login/token refresh (documented in the README).
 */
export const authenticate: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    next(ApiError.unauthorized('Missing or malformed Authorization header. Expected "Bearer <token>"'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Same as `authenticate`, but tolerates anonymous callers.
 * Used by endpoints that enrich the response when a user happens to be signed in.
 */
export const optionalAuthenticate: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch {
    // Ignore invalid tokens on public endpoints.
    next();
  }
};
