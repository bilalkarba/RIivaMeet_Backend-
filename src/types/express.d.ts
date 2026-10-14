import type { AuthenticatedUser } from '../utils/jwt.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware for protected routes. */
      user?: AuthenticatedUser;
      /** Correlation id echoed in logs and error responses. */
      requestId?: string;
      /** Validated payloads produced by the `validate` middleware. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
