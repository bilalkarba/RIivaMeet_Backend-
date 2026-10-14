import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, createCoach, registerUser, requestBooking, uniqueEmail } from '../helpers/api.js';
import { closeDatabase, prisma, resetDatabase } from '../helpers/database.js';

/** Booking lifecycle, ownership rules, overlap prevention and validation. */
describe('Bookings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/v1/bookings', () => {
    it('creates a PENDING booking and snapshots the price', async () => {
      const coach = await createCoach({ hourlyPrice: 45 });
      const client = await registerUser();

      const response = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        status: 'PENDING',
        priceAtBooking: '45.00',
        durationMinutes: 60,
      });
      expect(response.body.data.client).toMatchObject({ id: client.id });
      expect(response.body.data.coach.coachProfileId).toBe(coach.coachProfileId);

      const savedBooking = await prisma.booking.findUnique({
        where: { id: response.body.data.id },
        select: { clientId: true, coachProfileId: true, status: true, coachProfile: { select: { userId: true } } },
      });
      expect(savedBooking).toMatchObject({
        clientId: client.id,
        coachProfileId: coach.coachProfileId,
        status: 'PENDING',
        coachProfile: { userId: coach.id },
      });
      const savedNotification = await prisma.notification.findUnique({
        where: { bookingId: response.body.data.id },
        select: { recipientId: true, type: true, readAt: true },
      });
      expect(savedNotification).toEqual({
        recipientId: coach.id,
        type: 'BOOKING_REQUEST',
        readAt: null,
      });
    });

    it('prorates the price for part-hours and rounds to two decimals', async () => {
      const coach = await createCoach({ hourlyPrice: 50 });
      const client = await registerUser();

      const response = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1.5));

      expect(response.status).toBe(201);
      expect(response.body.data.priceAtBooking).toBe('75.00');
    });

    it('keeps the snapshotted price when the coach later changes their rate', async () => {
      const coach = await createCoach({ hourlyPrice: 40 });
      const client = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      expect(created.body.data.priceAtBooking).toBe('40.00');

      await api()
        .patch('/api/v1/coaches/me/profile')
        .set('Authorization', bearer(coach.token))
        .send({ hourlyPrice: 99 });

      const fetched = await api()
        .get(`/api/v1/bookings/${created.body.data.id}`)
        .set('Authorization', bearer(client.token));

      expect(fetched.body.data.priceAtBooking).toBe('40.00');
    });

    it('rejects a start time in the past', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const past = new Date(Date.now() - 3_600_000).toISOString();
      const response = await requestBooking(client.token, coach.coachProfileId, {
        startAt: past,
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('does not accept a client-supplied client ID', async () => {
      const coach = await createCoach();
      const client = await registerUser();
      const otherClient = await registerUser();

      const response = await api()
        .post('/api/v1/bookings')
        .set('Authorization', bearer(client.token))
        .send({ coachProfileId: coach.coachProfileId, clientId: otherClient.id, ...dayWindow(1, 10, 1) });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a window outside the coach availability with 409', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      // Availability is 09:00-18:00 UTC; 23:00 is outside it.
      const response = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 23, 1));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(String(response.body.error.message)).toContain('availability');
    });

    it('rejects a window that only partially overlaps availability', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      // 08:30-09:30 spills outside the 09:00 start.
      const base = new Date();
      base.setUTCHours(0, 0, 0, 0);
      const start = new Date(base);
      start.setUTCDate(base.getUTCDate() + 1);
      start.setUTCHours(8, 30, 0, 0);
      const end = new Date(start.getTime() + 3_600_000);

      const response = await requestBooking(client.token, coach.coachProfileId, {
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });

      expect(response.status).toBe(409);
    });

    it('rejects booking an unpublished or unknown coach with 404', async () => {
      const draft = await createCoach({ published: false });
      const client = await registerUser();

      const unpublished = await requestBooking(client.token, draft.coachProfileId, dayWindow(1, 10, 1));
      expect(unpublished.status).toBe(404);

      const unknown = await requestBooking(
        client.token,
        '00000000-0000-0000-0000-000000000000',
        dayWindow(1, 10, 1),
      );
      expect(unknown.status).toBe(404);

      const malformed = await requestBooking(client.token, 'invalid-coach-id', dayWindow(1, 12, 1));
      expect(malformed.status).toBe(400);
    });

    it('forbids a COACH account from creating booking requests (403)', async () => {
      const coach = await createCoach();

      // Requesting a booking is a client action; the self-booking guard in the service
      // is therefore a defence-in-depth check rather than a reachable API path.
      const response = await api()
        .post('/api/v1/bookings')
        .set('Authorization', bearer(coach.token))
        .send({ coachProfileId: coach.coachProfileId, ...dayWindow(1, 10, 1) });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects overlapping active bookings for the same client with 409', async () => {
      const coachA = await createCoach({ email: uniqueEmail('coacha') });
      const coachB = await createCoach({ email: uniqueEmail('coachb') });
      const client = await registerUser();

      const first = await requestBooking(client.token, coachA.coachProfileId, dayWindow(1, 10, 2));
      expect(first.status).toBe(201);

      const overlapping = await requestBooking(client.token, coachB.coachProfileId, dayWindow(1, 11, 1));
      expect(overlapping.status).toBe(409);
      expect(String(overlapping.body.error.message)).toContain('already have');
    });

    it('validates session length and ordering', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const sixtySeconds = new Date(Date.now() + 86_400_000);
      const tooShort = await requestBooking(client.token, coach.coachProfileId, {
        startAt: sixtySeconds.toISOString(),
        endAt: new Date(sixtySeconds.getTime() + 60_000).toISOString(),
      });
      expect(tooShort.status).toBe(400);

      const start = new Date(Date.now() + 86_400_000);
      const reversed = await requestBooking(client.token, coach.coachProfileId, {
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() - 3_600_000).toISOString(),
      });
      expect(reversed.status).toBe(400);

      const tooLong = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 5, 14));
      expect(tooLong.status).toBe(400);

      const badTimestamp = await api()
        .post('/api/v1/bookings')
        .set('Authorization', bearer(client.token))
        .send({ coachProfileId: coach.coachProfileId, startAt: 'tomorrow', endAt: 'later' });
      expect(badTimestamp.status).toBe(400);
    });
  });

  describe('status transitions', () => {
    it('accepts a pending booking (coach only) and rejects foreign coaches', async () => {
      const coach = await createCoach();
      const otherCoach = await createCoach({ email: uniqueEmail('other') });
      const client = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const bookingId = created.body.data.id;

      const foreign = await api()
        .patch(`/api/v1/bookings/${bookingId}/accept`)
        .set('Authorization', bearer(otherCoach.token));
      expect(foreign.status).toBe(403);

      const accepted = await api()
        .patch(`/api/v1/bookings/${bookingId}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.status).toBe('ACCEPTED');

      const acceptAgain = await api()
        .patch(`/api/v1/bookings/${bookingId}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(acceptAgain.status).toBe(409);
      expect(String(acceptAgain.body.error.message)).toContain('PENDING');
    });

    it('rejects a pending booking and treats REJECTED as terminal', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const bookingId = created.body.data.id;

      const rejected = await api()
        .patch(`/api/v1/bookings/${bookingId}/reject`)
        .set('Authorization', bearer(coach.token));
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('REJECTED');

      const acceptAfterReject = await api()
        .patch(`/api/v1/bookings/${bookingId}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(acceptAfterReject.status).toBe(409);

      const cancelAfterReject = await api()
        .patch(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', bearer(client.token));
      expect(cancelAfterReject.status).toBe(409);
    });

    it('lets the owning client cancel from PENDING and ACCEPTED', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const pending = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const cancelledFromPending = await api()
        .patch(`/api/v1/bookings/${pending.body.data.id}/cancel`)
        .set('Authorization', bearer(client.token));
      expect(cancelledFromPending.status).toBe(200);
      expect(cancelledFromPending.body.data.status).toBe('CANCELLED');

      const accepted = await requestBooking(client.token, coach.coachProfileId, dayWindow(2, 10, 1));
      await api()
        .patch(`/api/v1/bookings/${accepted.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));

      const cancelledFromAccepted = await api()
        .patch(`/api/v1/bookings/${accepted.body.data.id}/cancel`)
        .set('Authorization', bearer(client.token));
      expect(cancelledFromAccepted.status).toBe(200);
      expect(cancelledFromAccepted.body.data.status).toBe('CANCELLED');
    });

    it('lets the owning coach cancel and refuses unrelated users', async () => {
      const coach = await createCoach();
      const client = await registerUser();
      const stranger = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const bookingId = created.body.data.id;

      const strangerAttempt = await api()
        .patch(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', bearer(stranger.token));
      expect(strangerAttempt.status).toBe(403);

      const coachCancel = await api()
        .patch(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', bearer(coach.token));
      expect(coachCancel.status).toBe(200);
    });

    it('only the coach can complete, and only from ACCEPTED, after which it is terminal', async () => {
      const coach = await createCoach();
      const client = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const bookingId = created.body.data.id;

      const completePending = await api()
        .patch(`/api/v1/bookings/${bookingId}/complete`)
        .set('Authorization', bearer(coach.token));
      expect(completePending.status).toBe(409);

      const clientAttempt = await api()
        .patch(`/api/v1/bookings/${bookingId}/complete`)
        .set('Authorization', bearer(client.token));
      expect(clientAttempt.status).toBe(403);

      await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(coach.token));

      const completed = await api()
        .patch(`/api/v1/bookings/${bookingId}/complete`)
        .set('Authorization', bearer(coach.token));
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe('COMPLETED');

      const cancelCompleted = await api()
        .patch(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', bearer(client.token));
      expect(cancelCompleted.status).toBe(409);
    });
  });

  describe('overlap prevention', () => {
    it('prevents accepting a second booking that overlaps an accepted one', async () => {
      const coach = await createCoach();
      const clientA = await registerUser();
      const clientB = await registerUser();

      const first = await requestBooking(clientA.token, coach.coachProfileId, dayWindow(1, 10, 2));
      const second = await requestBooking(clientB.token, coach.coachProfileId, dayWindow(1, 11, 2));

      // Both pending requests are allowed; only one can be accepted.
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const acceptedFirst = await api()
        .patch(`/api/v1/bookings/${first.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(acceptedFirst.status).toBe(200);

      const acceptedSecond = await api()
        .patch(`/api/v1/bookings/${second.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(acceptedSecond.status).toBe(409);
      expect(String(acceptedSecond.body.error.message)).toContain('overlaps');
      expect(acceptedSecond.body.error.details.conflictingBookingId).toBe(first.body.data.id);
    });

    it('allows back-to-back (non-overlapping) accepted bookings', async () => {
      const coach = await createCoach();
      const clientA = await registerUser();
      const clientB = await registerUser();

      const morning = await requestBooking(clientA.token, coach.coachProfileId, dayWindow(1, 9, 2));
      const lateMorning = await requestBooking(clientB.token, coach.coachProfileId, dayWindow(1, 11, 2));

      const acceptedMorning = await api()
        .patch(`/api/v1/bookings/${morning.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));
      const acceptedLate = await api()
        .patch(`/api/v1/bookings/${later(lateMorning)}/accept`)
        .set('Authorization', bearer(coach.token));

      expect(acceptedMorning.status).toBe(200);
      expect(acceptedLate.status).toBe(200);
    });

    it('allows a slot again once the conflicting booking is cancelled', async () => {
      const coach = await createCoach();
      const clientA = await registerUser();
      const clientB = await registerUser();

      const first = await requestBooking(clientA.token, coach.coachProfileId, dayWindow(1, 10, 2));
      const second = await requestBooking(clientB.token, coach.coachProfileId, dayWindow(1, 10, 2));

      await api().patch(`/api/v1/bookings/${first.body.data.id}/accept`).set('Authorization', bearer(coach.token));
      await api().patch(`/api/v1/bookings/${first.body.data.id}/cancel`).set('Authorization', bearer(clientA.token));

      const acceptedSecond = await api()
        .patch(`/api/v1/bookings/${second.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));
      expect(acceptedSecond.status).toBe(200);
    });

    it('is race-safe: concurrent accepts of overlapping bookings yield exactly one success', async () => {
      const coach = await createCoach();
      const clientA = await registerUser();
      const clientB = await registerUser();

      const first = await requestBooking(clientA.token, coach.coachProfileId, dayWindow(3, 10, 2));
      const second = await requestBooking(clientB.token, coach.coachProfileId, dayWindow(3, 11, 2));

      const [resultA, resultB] = await Promise.all([
        api().patch(`/api/v1/bookings/${first.body.data.id}/accept`).set('Authorization', bearer(coach.token)),
        api().patch(`/api/v1/bookings/${second.body.data.id}/accept`).set('Authorization', bearer(coach.token)),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const accepted = await api()
        .get('/api/v1/bookings/mine')
        .query({ status: 'ACCEPTED' })
        .set('Authorization', bearer(coach.token));
      expect(accepted.body.data).toHaveLength(1);
      expect(accepted.body.meta.total).toBe(1);
    });
  });

  describe('listing and access control', () => {
    it('scopes /bookings/mine by role and supports status filters', async () => {
      const coach = await createCoach();
      const otherCoach = await createCoach({ email: uniqueEmail('other-coach') });
      const client = await registerUser();
      const otherClient = await registerUser();
      const thirdClient = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      await requestBooking(otherClient.token, coach.coachProfileId, dayWindow(1, 14, 1));
      await requestBooking(thirdClient.token, otherCoach.coachProfileId, dayWindow(1, 12, 1));

      const clientList = await api().get('/api/v1/bookings/mine').set('Authorization', bearer(client.token));
      expect(clientList.body.data).toHaveLength(1);
      expect(clientList.body.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });

      const coachList = await api().get('/api/v1/bookings/mine').set('Authorization', bearer(coach.token));
      expect(coachList.body.data).toHaveLength(2);
      expect(coachList.body.data.every((booking: { coach: { coachProfileId: string } }) =>
        booking.coach.coachProfileId === coach.coachProfileId,
      )).toBe(true);

      const pendingOnly = await api()
        .get('/api/v1/bookings/mine')
        .query({ status: 'PENDING' })
        .set('Authorization', bearer(coach.token));
      expect(pendingOnly.body.data).toHaveLength(2);
      expect(pendingOnly.body.meta.total).toBe(2);

      const otherCoachList = await api()
        .get('/api/v1/bookings/mine')
        .set('Authorization', bearer(otherCoach.token));
      expect(otherCoachList.body.data).toHaveLength(1);
      expect(otherCoachList.body.data[0].coach.coachProfileId).toBe(otherCoach.coachProfileId);

      await api()
        .patch(`/api/v1/bookings/${created.body.data.id}/accept`)
        .set('Authorization', bearer(coach.token));

      const acceptedOnly = await api()
        .get('/api/v1/bookings/mine')
        .query({ status: 'ACCEPTED' })
        .set('Authorization', bearer(coach.token));
      expect(acceptedOnly.body.data).toHaveLength(1);
      expect(acceptedOnly.body.data[0].status).toBe('ACCEPTED');

      const invalidStatus = await api()
        .get('/api/v1/bookings/mine')
        .query({ status: 'DONE' })
        .set('Authorization', bearer(coach.token));
      expect(invalidStatus.status).toBe(400);
    });

    it('returns an empty list for a coach without a profile', async () => {
      const coach = await registerUser({ role: 'COACH' });

      const response = await api().get('/api/v1/bookings/mine').set('Authorization', bearer(coach.token));

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.total).toBe(0);
    });

    it('restricts GET /bookings/:id to participants', async () => {
      const coach = await createCoach();
      const client = await registerUser();
      const stranger = await registerUser();

      const created = await requestBooking(client.token, coach.coachProfileId, dayWindow(1, 10, 1));
      const bookingId = created.body.data.id;

      const asClient = await api().get(`/api/v1/bookings/${bookingId}`).set('Authorization', bearer(client.token));
      expect(asClient.status).toBe(200);

      const asCoach = await api().get(`/api/v1/bookings/${bookingId}`).set('Authorization', bearer(coach.token));
      expect(asCoach.status).toBe(200);

      const asStranger = await api().get(`/api/v1/bookings/${bookingId}`).set('Authorization', bearer(stranger.token));
      expect(asStranger.status).toBe(403);

      const unknown = await api()
        .get('/api/v1/bookings/00000000-0000-0000-0000-000000000000')
        .set('Authorization', bearer(client.token));
      expect(unknown.status).toBe(404);

      const malformed = await api().get('/api/v1/bookings/abc').set('Authorization', bearer(client.token));
      expect(malformed.status).toBe(400);
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

/** Local helper: extract the created booking id from a response. */
function later(response: { body: { data: { id: string } } }): string {
  return response.body.data.id;
}
