import { z } from 'zod';

import { ExperienceLevel } from '../generated/prisma/enums.js';
import {
  latitudeQuery,
  limitQuery,
  longitudeQuery,
  pageQuery,
  radiusQuery,
  trimmedString,
  uuidSchema,
} from './common.schema.js';

/**
 * Self-service profile schemas (Phase 1).
 *
 * Every field is optional so an account can start minimal and be completed over time.
 * `null` explicitly clears a field; omitting it leaves the stored value unchanged.
 */

export const experienceLevelSchema = z.enum(ExperienceLevel);

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), 'avatarUrl must be an http(s) URL');

export const updateProfileBodySchema = z
  .object({
    displayName: trimmedString(2, 60).nullable().optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
    bio: trimmedString(0, 2000).nullable().optional(),
    city: trimmedString(2, 80).nullable().optional(),
    country: trimmedString(2, 60).nullable().optional(),
    level: experienceLevelSchema.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const replaceProfileSportsBodySchema = z
  .object({
    sportIds: z.array(uuidSchema).min(1, 'Provide at least one discipline').max(20).optional(),
    sportSlugs: z.array(trimmedString(2, 60)).min(1, 'Provide at least one discipline').max(20).optional(),
    level: experienceLevelSchema.nullable().optional(),
  })
  .strict()
  .refine((data) => Boolean(data.sportIds) || Boolean(data.sportSlugs), {
    message: 'Provide either sportIds or sportSlugs',
  })
  .refine((data) => !(data.sportIds && data.sportSlugs), {
    message: 'Provide sportIds or sportSlugs, not both',
  });

export const addProfileSportBodySchema = z
  .object({
    sportId: uuidSchema,
    level: experienceLevelSchema.nullable().optional(),
  })
  .strict();

/**
 * Compatible-profile suggestions.
 *
 * All filters are optional: with no filters the viewer's own profile (disciplines,
 * level, city/country) drives the ranking. `latitude`/`longitude` add `distanceKm`.
 */
export const suggestionsQuerySchema = z
  .object({
    sport: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 60).optional(),
    ),
    level: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      experienceLevelSchema.optional(),
    ),
    city: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 80).optional(),
    ),
    country: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      trimmedString(2, 60).optional(),
    ),
    latitude: latitudeQuery,
    longitude: longitudeQuery,
    radiusKm: radiusQuery,
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
  });

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
export type ReplaceProfileSportsBody = z.infer<typeof replaceProfileSportsBodySchema>;
export type AddProfileSportBody = z.infer<typeof addProfileSportBodySchema>;
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;
