import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';

import { ApiError } from '../utils/errors.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

function toIssues(error: ZodError, source: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [source, ...issue.path.map(String)].join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Zod request validation.
 *
 * Parses `body`, `query` and `params`, replacing them with the *parsed* values
 * (coerced numbers, trimmed strings, applied defaults) in `req.validated`.
 *
 * Express 5 defines `req.query` as a getter, so the validated query is exposed
 * through `req.validated.query` and read with the `validatedQuery()` helper below
 * instead of being assigned back onto the request.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const validated: NonNullable<Request['validated']> = {};

    try {
      if (schemas.params) {
        validated.params = schemas.params.parse(req.params);
      }
      if (schemas.query) {
        validated.query = schemas.query.parse(req.query);
      }
      if (schemas.body) {
        validated.body = schemas.body.parse(req.body ?? {});
      }
    } catch (error) {
      if (error instanceof ZodError) {
        const source = schemas.body ? 'body' : schemas.query ? 'query' : 'params';
        next(ApiError.badRequest('Request validation failed', toIssues(error, source)));
        return;
      }
      next(error);
      return;
    }

    req.validated = { ...req.validated, ...validated };
    next();
  };
}

/** Read the parsed body. Throws if the route was not wired with `validate({ body })`. */
export function validatedBody<T>(req: Request): T {
  return (req.validated?.body ?? {}) as T;
}

/** Read the parsed query string. */
export function validatedQuery<T>(req: Request): T {
  return (req.validated?.query ?? {}) as T;
}

/** Read the parsed route params. */
export function validatedParams<T>(req: Request): T {
  return (req.validated?.params ?? {}) as T;
}
