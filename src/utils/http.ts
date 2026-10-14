import type { Response } from 'express';

/**
 * Consistent JSON envelopes.
 *
 * Success:  { "data": ... }                 or { "data": [...], "meta": {...} }
 * Failure:  { "error": { "code", "message", "details?" }, "requestId": "..." }
 */

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && total > 0,
  };
}

export function sendData<T>(res: Response, data: T, statusCode = 200): Response {
  return res.status(statusCode).json({ data });
}

export function sendMessage(res: Response, data: unknown, statusCode = 200): Response {
  // Small helper used for endpoints that simply confirm a state change.
  return res.status(statusCode).json({ data });
}

/**
 * Paginated response: `{ data, meta }`.
 * `M` lets an endpoint add extras to the pagination metadata (e.g. a rating summary)
 * without losing type safety.
 */
export function sendPaginated<T, M extends object = object>(
  res: Response,
  data: T[],
  meta: PaginationMeta & M,
  statusCode = 200,
): Response {
  return res.status(statusCode).json({ data, meta });
}

export function sendCreated<T>(res: Response, data: T): Response {
  return sendData(res, data, 201);
}
