import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, completeBooking, createCoach, registerUser, requestBooking, reviewBooking } from '../helpers/api.js';
import { closeDatabase, prisma, resetDatabase } from '../helpers/database.js';

/** Review eligibility, uniqueness, validation and rating aggregates. */
describe('Reviews', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/v1/bookings/:id/review', () => {
    it('creates a review for a completed booking', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      expect(completed.status).toBe(200);

      const response = await reviewBooking(client.token, completed.body.data.id, {
        rating: 5,
        comment: 'Fantastic session, very structured and motivating.',
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        bookingId: completed.body.data.id,
        rating: 5,
        comment: 'Fantastic session, very structured and motivating.',
        client: { id: client.id },
      });
      expect(response.body.data).not.toHaveProperty('clientId');
    });

    it('accepts a review without a comment', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      const response = await reviewBooking(client.token, completed.body.data.id, { rating: 4 });

      expect(response.status).toBe(201);
      expect(response.body.data.comment).toBeNull();
    });

    it('prevents duplicate reviews for the same booking (409)', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));

      const first = await reviewBooking(client.token, completed.body.data.id, { rating: 5, comment: 'Superb.' });
      expect(first.status).toBe(201);

      const second = await reviewBooking(client.token, completed.body.data.id, { rating: 3, comment: 'Changed my mind.' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT');

      const count = await prisma.review.count({ where: { bookingId: completed.body.data.id } });
      expect(count).toBe(1);
    });

    it('prevents duplicate reviews even when two requests race', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));

      const [first, second] = await Promise.all([
        reviewBooking(client.token, completed.body.data.id, { rating: 5, comment: 'First attempt.' }),
        reviewBooking(client.token, completed.body.data.id, { rating: 4, comment: 'Second attempt.' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(await prisma.review.count({ where: { bookingId: completed.body.data.id } })).toBe(1);
    });

    it('rejects reviews for bookings that are not completed', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const pending = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));

      const reviewPending = await reviewBooking(client.token, pending.body.data.id, { rating: 5, comment: 'Too early.' });
      expect(reviewPending.status).toBe(409);
      expect(String(reviewPending.body.error.message)).toMatch(/only completed bookings/i);
      expect(reviewPending.body.error.details).toMatchObject({ currentStatus: 'PENDING', requiredStatus: 'COMPLETED' });

      await api()
        .patch(`/api/v1/bookings/${pending.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));

      const reviewAccepted = await reviewBooking(client.token, pending.body.data.id, {
        rating: 5,
        comment: 'Still too early.',
      });
      expect(reviewAccepted.status).toBe(409);
    });

    it('only allows the client who owns the booking to review it', async () => {
      const coach = await createCoach();
      const client = await registerUser();
      const otherClient = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));

      const response = await reviewBooking(otherClient.token, completed.body.data.id, {
        rating: 5,
        comment: 'I was not even there.',
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('forbids coaches from submitting reviews', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));

      const response = await reviewBooking(coach.token, completed.body.data.id, { rating: 5, comment: 'Self praise.' });

      expect(response.status).toBe(403);
    });

    it('returns 404 for an unknown booking', async () => {
      const client = await registerUser();

      const response = await reviewBooking(client.token, '00000000-0000-0000-0000-000000000000', {
        rating: 5,
        comment: 'Ghost booking.',
      });

      expect(response.status).toBe(404);
    });

    it.each([
      ['rating below 1', { rating: 0, comment: 'Just okay.' }],
      ['rating above 5', { rating: 6, comment: 'Perfect score plus one.' }],
      ['non-integer rating', { rating: 4.5, comment: 'Half a star.' }],
      ['missing rating', { comment: 'No rating at all.' }],
      ['comment too short', { rating: 5, comment: 'ok' }],
      ['comment too long', { rating: 5, comment: 'x'.repeat(1001) }],
      ['unknown field', { rating: 5, comment: 'Nice session overall.', coachProfileId: 'sneaky' }],
    ])('rejects %s with 400', async (_label, payload) => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));

      const response = await reviewBooking(client.token, completed.body.data.id, payload as { rating: number });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('rating aggregates and GET /api/v1/coaches/:id/reviews', () => {
    it('lists reviews with a derived rating summary', async () => {
      const coach = await createCoach();
      const clientOne = await registerUser();
      const clientTwo = await registerUser();

      const first = await completeBooking(clientOne.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      await reviewBooking(clientOne.token, first.body.data.id, { rating: 5, comment: 'Excellent coaching.' });

      const second = await completeBooking(clientTwo.token, coach.token, coach.coachProfileId, dayWindow(1, 14));
      await reviewBooking(clientTwo.token, second.body.data.id, { rating: 4, comment: 'Very good session.' });

      const response = await api().get(`/api/v1/coaches/${coach.coachProfileId}/reviews`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta.total).toBe(2);
      expect(response.body.meta.summary).toEqual({ averageRating: 4.5, reviewCount: 2 });
    });

    it('paginates reviews', async () => {
      const coach = await createCoach({ availabilityDays: 5 });
      const client = await registerUser();

      for (let index = 0; index < 3; index += 1) {
        const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 9 + index));
        // `created_at` has millisecond precision, so space the reviews out to keep the
        // "newest first" ordering deterministic.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await reviewBooking(client.token, completed.body.data.id, { rating: 3 + index, comment: `Session number ${index}.` });
      }

      const response = await api().get(`/api/v1/coaches/${coach.coachProfileId}/reviews`).query({ page: 1, limit: 2 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2, hasNextPage: true });
      // Newest first.
      expect(response.body.data[0].rating).toBe(5);
    });

    it('exposes the rating in coach search and detail', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const beforeReview = await api().get(`/api/v1/coaches/${coach.coachProfileId}`);
      expect(beforeReview.body.data.averageRating).toBeNull();
      expect(beforeReview.body.data.reviewCount).toBe(0);

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      await reviewBooking(client.token, completed.body.data.id, { rating: 4, comment: 'Solid technical coaching.' });

      const detail = await api().get(`/api/v1/coaches/${coach.coachProfileId}`);
      expect(detail.body.data.averageRating).toBe(4);
      expect(detail.body.data.reviewCount).toBe(1);
      expect(detail.body.data.totalBookings).toBe(1);

      const search = await api().get('/api/v1/coaches');
      expect(search.body.data[0].averageRating).toBe(4);
      expect(search.body.data[0].reviewCount).toBe(1);

      // The average is derived, never stored: adding a second review updates it.
      const secondClient = await registerUser();
      const second = await completeBooking(secondClient.token, coach.token, coach.coachProfileId, dayWindow(2, 10));
      await reviewBooking(secondClient.token, second.body.data.id, { rating: 5, comment: 'Best coach in town.' });

      const updated = await api().get(`/api/v1/coaches/${coach.coachProfileId}`);
      expect(updated.body.data.averageRating).toBe(4.5);
      expect(updated.body.data.reviewCount).toBe(2);
    });

    it('hides reviews of unpublished or unknown coaches (404)', async () => {
      const draft = await createCoach({ published: false });

      const unpublished = await api().get(`/api/v1/coaches/${draft.coachProfileId}/reviews`);
      expect(unpublished.status).toBe(404);

      const unknown = await api().get('/api/v1/coaches/00000000-0000-0000-0000-000000000000/reviews');
      expect(unknown.status).toBe(404);
    });
  });

  describe('database-level guarantees', () => {
    it('enforces the rating range with a CHECK constraint', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      await reviewBooking(client.token, completed.body.data.id, { rating: 5, comment: 'Great session overall.' });

      const review = await prisma.review.findFirstOrThrow({ where: { bookingId: completed.body.data.id } });

      // Bypasses Prisma/Zod entirely - only the database constraint can stop this.
      await expect(
        prisma.$executeRawUnsafe('UPDATE "reviews" SET "rating" = 9 WHERE "id" = $1::uuid', review.id),
      ).rejects.toThrow(/reviews_rating_range|check constraint/i);
    });

    it('enforces the booking time range with a CHECK constraint', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const completed = await completeBooking(client.token, coach.token, coach.coachProfileId, dayWindow(1, 10));
      const bookingId = completed.body.data.id;

      await expect(
        prisma.$executeRawUnsafe(
          'UPDATE "bookings" SET "end_at" = "start_at" - interval \'1 hour\' WHERE "id" = $1::uuid',
          bookingId,
        ),
      ).rejects.toThrow(/bookings_time_range_valid|check constraint/i);
    });
  });
});

/** Local helper: `dayOffset` days from today at `hour` UTC, for `durationHours`. */
function dayWindow(dayOffset: number, hour: number, durationHours = 1): { startAt: string; endAt: string } {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() + dayOffset);
  start.setUTCHours(hour, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + durationHours * 3_600_000).toISOString() };
}
