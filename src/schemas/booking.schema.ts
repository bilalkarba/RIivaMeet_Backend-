import { z } from 'zod';

import { BookingStatus } from '../generated/prisma/enums.js';
import { isoDateTimeSchema, limitQuery, pageQuery, uuidSchema } from './common.schema.js';

export const bookingStatusSchema = z.enum(BookingStatus);

/** Sessions must last between 15 minutes and 12 hours. */
export const MIN_SESSION_MINUTES = 15;
export const MAX_SESSION_MINUTES = 12 * 60;

export const createBookingBodySchema = z
  .object({
    coachProfileId: uuidSchema,
    startAt: isoDateTimeSchema,
    endAt: isoDateTimeSchema,
  })
  .strict()
  .refine((data) => new Date(data.startAt).getTime() < new Date(data.endAt).getTime(), {
    message: 'startAt must be before endAt',
    path: ['endAt'],
  })
  .refine(
    (data) => {
      const minutes = (new Date(data.endAt).getTime() - new Date(data.startAt).getTime()) / 60_000;
      return minutes >= MIN_SESSION_MINUTES;
    },
    { message: `A session must last at least ${MIN_SESSION_MINUTES} minutes`, path: ['endAt'] },
  )
  .refine(
    (data) => {
      const minutes = (new Date(data.endAt).getTime() - new Date(data.startAt).getTime()) / 60_000;
      return minutes <= MAX_SESSION_MINUTES;
    },
    { message: `A session must last at most ${MAX_SESSION_MINUTES} minutes`, path: ['endAt'] },
  );

export const listBookingsQuerySchema = z
  .object({
    status: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      bookingStatusSchema.optional(),
    ),
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const createReviewBodySchema = z
  .object({
    rating: z
      .number()
      .int('rating must be a whole number')
      .min(1, 'rating must be between 1 and 5')
      .max(5, 'rating must be between 1 and 5'),
    comment: z.string().trim().min(3, 'comment must be at least 3 characters').max(1000, 'comment must be at most 1000 characters').optional(),
  })
  .strict();

export const listReviewsQuerySchema = z
  .object({
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type CreateReviewBody = z.infer<typeof createReviewBodySchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
