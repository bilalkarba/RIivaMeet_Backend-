import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import { env } from '../config/env.js';
import { ErrorCode } from '../utils/errors.js';

/**
 * Rate limiting.
 *
 * - `globalRateLimiter` is a coarse protection for the whole API surface.
 * - `authRateLimiter` is deliberately much stricter and applied to register/login,
 *   where brute-forcing credentials is the realistic attack.
 *
 * Responses use the same error envelope as the rest of the API. In tests the limits
 * are raised via environment variables so suites are not throttled.
 */

const rateLimitedBody = (message: string) => ({
  error: {
    code: ErrorCode.RATE_LIMITED,
    message,
  },
});

export const globalRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.isTest ? 100_000 : env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Health checks are excluded so platform probes never trip the limiter.
  skip: (req) => req.path === '/health',
  handler: (_req: Request, res: Response, _next: NextFunction) => {
    res.status(429).json(rateLimitedBody('Too many requests. Please slow down and try again later.'));
  },
});

export const chatRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.isTest ? 100_000 : env.CHAT_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Keyed by account, not IP: chat routes are always authenticated, and this stops a
  // single shared NAT from throttling unrelated users. `validate.trustProxy` is set on
  // the app, so `req.ip` would be accurate too, but the account is the fairer unit.
  keyGenerator: (req) => req.user?.id ?? 'anonymous',
  handler: (_req: Request, res: Response, _next: NextFunction) => {
    res
      .status(429)
      .json(rateLimitedBody('You are sending messages too quickly. Please slow down.'));
  },
});

export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.isTest ? 100_000 : env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Successful logins should not count towards the brute-force budget.
  skipSuccessfulRequests: true,
  handler: (req: Request, res: Response, _next: NextFunction) => {
    res
      .status(429)
      .json(
        rateLimitedBody(
          'Too many authentication attempts from this IP. Please try again later.',
        ),
      );
    void req;
  },
});
