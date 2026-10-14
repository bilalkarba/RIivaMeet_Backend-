import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { ApiError, ErrorCode, type ApiErrorBody } from '../utils/errors.js';

/** Terminal middleware for unmatched routes. */
export const notFoundHandler: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
};

interface ErrorResponseWithDetails {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): ErrorResponseWithDetails {
  switch (error.code) {
    case 'P2002': {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(', ') : typeof target === 'string' ? target : 'field';
      return {
        code: ErrorCode.CONFLICT,
        message: `A record with this ${fields} already exists`,
        details: { constraint: fields },
      };
    }
    case 'P2003':
      return { code: ErrorCode.CONFLICT, message: 'Related record constraint violated' };
    case 'P2025':
      return { code: ErrorCode.NOT_FOUND, message: 'Resource not found' };
    case 'P2034':
      return {
        code: ErrorCode.CONFLICT,
        message: 'The request conflicted with a concurrent operation. Please retry.',
      };
    default:
      return { code: ErrorCode.INTERNAL_ERROR, message: 'Database request failed' };
  }
}

function isJsonBodyError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: number }).status === 400 &&
    'body' in error
  );
}

/**
 * Centralized error handler. Must be registered last.
 *
 * Guarantees:
 *  - a stable, machine-readable `error.code` for every failure;
 *  - HTTP status codes that match the situation (400/401/403/404/409/429/500);
 *  - never leaks stack traces or driver internals to clients in production
 *    (the full error is always logged server-side with the request id).
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = req.requestId;
  let statusCode = 500;
  let response: ErrorResponseWithDetails = {
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
  };
  let logLevel: 'warn' | 'error' = 'error';

  if (error instanceof ApiError) {
    statusCode = error.statusCode;
    response = { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
    logLevel = statusCode >= 500 ? 'error' : 'warn';
  } else if (error instanceof ZodError) {
    statusCode = 400;
    response = {
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      })),
    };
    logLevel = 'warn';
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrismaError(error);
    statusCode = mapped.code === ErrorCode.CONFLICT ? 409 : mapped.code === ErrorCode.NOT_FOUND ? 404 : 500;
    response = { ...mapped, ...(env.isProduction ? {} : { details: { prismaCode: error.code } }) };
    logLevel = statusCode >= 500 ? 'error' : 'warn';
  } else if (error instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    response = { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid data supplied to the database layer' };
    logLevel = 'warn';
  } else if (isJsonBodyError(error)) {
    statusCode = 400;
    response = { code: ErrorCode.VALIDATION_ERROR, message: 'Malformed JSON body' };
    logLevel = 'warn';
  } else if ((error as { type?: string })?.type === 'entity.too.large') {
    statusCode = 413;
    response = { code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'Request payload too large' };
    logLevel = 'warn';
  }

  const logPayload = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code: response.code,
    err: error,
  };

  if (logLevel === 'error') {
    logger.error(logPayload, response.message);
  } else {
    logger.warn(logPayload, response.message);
  }

  const body: ApiErrorBody = {
    error: response,
    ...(requestId ? { requestId } : {}),
  };

  res.status(statusCode).json(body);
}
