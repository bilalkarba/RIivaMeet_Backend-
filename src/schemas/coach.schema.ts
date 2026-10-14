import { z } from 'zod';

import { ExperienceLevel } from '../generated/prisma/enums.js';
import {
  isoDateTimeSchema,
  latitudeQuery,
  limitQuery,
  longitudeQuery,
  pageQuery,
  positiveMoneyQuery,
  radiusQuery,
  ratingQuery,
  trimmedString,
  uuidSchema,
} from './common.schema.js';

export const experienceLevelSchema = z.enum(ExperienceLevel);

const bioSchema = trimmedString(20, 2000);
const citySchema = trimmedString(2, 80);
const neighborhoodSchema = trimmedString(2, 80);

/** Coach certifications/qualifications. Replaced wholesale on update. */
const certificationsSchema = z
  .array(trimmedString(2, 120))
  .max(20, 'At most 20 certifications are allowed');

/**
 * Hourly price is accepted as a number and stored as `decimal(10,2)`.
 * Two decimal places maximum, matching the database column.
 */
const hourlyPriceSchema = z
  .number()
  .min(0, 'hourlyPrice must be >= 0')
  .max(100_000, 'hourlyPrice must be <= 100000')
  .refine((value) => Number.isInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, {
    message: 'hourlyPrice supports at most 2 decimal places',
  });

const latitudeSchema = z.number().min(-90, 'latitude must be >= -90').max(90, 'latitude must be <= 90');
const longitudeSchema = z.number().min(-180, 'longitude must be >= -180').max(180, 'longitude must be <= 180');

export const createCoachProfileBodySchema = z
  .object({
    bio: bioSchema,
    certifications: certificationsSchema.optional(),
    hourlyPrice: hourlyPriceSchema,
    experienceLevel: experienceLevelSchema,
    city: citySchema,
    neighborhood: neighborhoodSchema,
    address: trimmedString(3, 200).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    isPublished: z.boolean().default(false),
  })
  .strict()
  .refine((data) => (data.latitude === undefined) === (data.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
    path: ['latitude'],
  });

export const updateCoachProfileBodySchema = z
  .object({
    bio: bioSchema.optional(),
    certifications: certificationsSchema.optional(),
    hourlyPrice: hourlyPriceSchema.optional(),
    experienceLevel: experienceLevelSchema.optional(),
    city: citySchema.optional(),
    neighborhood: neighborhoodSchema.optional(),
    address: trimmedString(3, 200).nullable().optional(),
    latitude: latitudeSchema.nullable().optional(),
    longitude: longitudeSchema.nullable().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict();

export const replaceCoachSportsBodySchema = z
  .object({
    sportIds: z.array(uuidSchema).min(1, 'Provide at least one sport').max(20).optional(),
    sportSlugs: z.array(trimmedString(2, 60)).min(1, 'Provide at least one sport').max(20).optional(),
  })
  .strict()
  .refine((data) => Boolean(data.sportIds) || Boolean(data.sportSlugs), {
    message: 'Provide either sportIds or sportSlugs',
  })
  .refine((data) => !(data.sportIds && data.sportSlugs), {
    message: 'Provide sportIds or sportSlugs, not both',
  });

export const createAvailabilityBodySchema = z
  .object({
    startAt: isoDateTimeSchema,
    endAt: isoDateTimeSchema,
    isAvailable: z.boolean().default(true),
  })
  .strict()
  .refine((data) => new Date(data.startAt).getTime() < new Date(data.endAt).getTime(), {
    message: 'startAt must be before endAt',
    path: ['endAt'],
  });

/**
 * Coach search.
 * - Supported sort keys: newest | oldest | price_asc | price_desc | rating_desc |
 *   rating_asc | distance_asc | distance_desc.
 * - Filtering by distance (or sorting by it) requires latitude + longitude.
 * - `sport` accepts a sport slug ("boxing") or a sport name ("Boxing").
 */
export const COACH_SORT_VALUES = [
  'newest',
  'oldest',
  'price_asc',
  'price_desc',
  'rating_desc',
  'rating_asc',
  'distance_asc',
  'distance_desc',
] as const;

export const coachSortSchema = z.enum(COACH_SORT_VALUES);

export type CoachSort = z.infer<typeof coachSortSchema>;

export const searchCoachesQuerySchema = z
  .object({
    sport: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 60).optional(),
    ),
    city: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 80).optional(),
    ),
    neighborhood: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 80).optional(),
    ),
    level: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      experienceLevelSchema.optional(),
    ),
    country: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 60).optional(),
    ),
    minPrice: positiveMoneyQuery,
    maxPrice: positiveMoneyQuery,
    minRating: ratingQuery,
    latitude: latitudeQuery,
    longitude: longitudeQuery,
    radiusKm: radiusQuery,
    sort: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      coachSortSchema.default('newest'),
    ),
    page: pageQuery,
    limit: limitQuery,
  })
  .strict()
  .refine((data) => (data.latitude === undefined) === (data.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
    path: ['latitude'],
  })
  .refine((data) => data.radiusKm === undefined || data.latitude !== undefined, {
    message: 'radiusKm requires latitude and longitude',
    path: ['radiusKm'],
  })
  .refine(
    (data) => data.sort !== 'distance_asc' && data.sort !== 'distance_desc' ? true : data.latitude !== undefined,
    {
      message: 'sorting by distance requires latitude and longitude',
      path: ['sort'],
    },
  )
  .refine((data) => data.minPrice === undefined || data.maxPrice === undefined || data.minPrice <= data.maxPrice, {
    message: 'minPrice must be less than or equal to maxPrice',
    path: ['minPrice'],
  });

export type SearchCoachesQuery = z.infer<typeof searchCoachesQuerySchema>;
export type CreateCoachProfileBody = z.infer<typeof createCoachProfileBodySchema>;
export type UpdateCoachProfileBody = z.infer<typeof updateCoachProfileBodySchema>;
export type CreateAvailabilityBody = z.infer<typeof createAvailabilityBodySchema>;
