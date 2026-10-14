import { z } from 'zod';

import { LATITUDE_MAX, LATITUDE_MIN, LONGITUDE_MAX, LONGITUDE_MIN, RADIUS_MAX_KM } from '../utils/geo.js';

/**
 * Shared Zod building blocks.
 *
 * Query-string values always arrive as strings, so numeric query fields are
 * preprocessed: an empty parameter (`?page=`) is treated as "not provided" and a
 * non-numeric value produces a clear validation error instead of NaN.
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const trimmedString = (min: number, max: number) =>
  z.string().trim().min(min, `Must be at least ${min} characters`).max(max, `Must be at most ${max} characters`);

export const uuidSchema = z.uuid('Must be a valid UUID');

export const uuidParamSchema = z.object({ id: uuidSchema });

export const isoDateTimeSchema = z.iso.datetime({
  offset: true,
  message: 'Must be an ISO 8601 timestamp with an explicit offset, e.g. 2026-05-01T10:00:00.000Z',
});

export const pageQuery = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int('page must be an integer').min(1, 'page must be >= 1').default(1),
);

export const limitQuery = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int('limit must be an integer').min(1, 'limit must be >= 1').max(100, 'limit must be <= 100').default(20),
);

export const paginationQuerySchema = z.object({
  page: pageQuery,
  limit: limitQuery,
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const latitudeQuery = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .min(LATITUDE_MIN, `latitude must be >= ${LATITUDE_MIN}`)
    .max(LATITUDE_MAX, `latitude must be <= ${LATITUDE_MAX}`)
    .optional(),
);

export const longitudeQuery = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .min(LONGITUDE_MIN, `longitude must be >= ${LONGITUDE_MIN}`)
    .max(LONGITUDE_MAX, `longitude must be <= ${LONGITUDE_MAX}`)
    .optional(),
);

export const radiusQuery = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .positive('radiusKm must be > 0')
    .max(RADIUS_MAX_KM, `radiusKm must be <= ${RADIUS_MAX_KM}`)
    .optional(),
);

export const positiveMoneyQuery = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(0, 'must be >= 0').max(1_000_000, 'must be <= 1000000').optional(),
);

export const ratingQuery = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(1, 'minRating must be >= 1').max(5, 'minRating must be <= 5').optional(),
);
