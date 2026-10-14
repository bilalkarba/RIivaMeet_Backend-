import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Role } from '../generated/prisma/enums.js';
import { ApiError } from '../utils/errors.js';

/**
 * Role-based authorization. Must run after `authenticate`.
 *
 * Usage: `router.post('/me/profile', authenticate, authorize(Role.COACH), handler)`
 */
export function authorize(...allowedRoles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(
        ApiError.forbidden(
          `This action requires one of the following roles: ${allowedRoles.join(', ')}`,
        ),
      );
      return;
    }

    next();
  };
}
