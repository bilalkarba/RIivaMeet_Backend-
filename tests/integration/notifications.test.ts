import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, bookingWindow, createCoach, registerUser, requestBooking } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

describe('Booking notifications', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('delivers an unread booking alert only to the owning coach', async () => {
    const coach = await createCoach();
    const otherCoach = await createCoach({ email: 'other-notification-coach@example.com' });
    const client = await registerUser();

    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(1, 10));
    expect(created.status).toBe(201);

    const coachInbox = await api()
      .get('/api/v1/notifications/mine')
      .set('Authorization', bearer(coach.token));
    expect(coachInbox.status).toBe(200);
    expect(coachInbox.body.data).toMatchObject({
      unreadCount: 1,
      notifications: [
        {
          type: 'BOOKING_REQUEST',
          bookingId: created.body.data.id,
          clientName: 'Test Client',
          readAt: null,
        },
      ],
    });

    const clientInbox = await api()
      .get('/api/v1/notifications/mine')
      .set('Authorization', bearer(client.token));
    expect(clientInbox.body.data).toEqual({ notifications: [], unreadCount: 0 });

    const otherCoachInbox = await api()
      .get('/api/v1/notifications/mine')
      .set('Authorization', bearer(otherCoach.token));
    expect(otherCoachInbox.body.data).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('marks only the authenticated user’s alerts as read', async () => {
    const coach = await createCoach();
    const otherCoach = await createCoach({ email: 'other-read-coach@example.com' });
    const client = await registerUser();
    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(1, 10));

    const clientMark = await api()
      .patch('/api/v1/notifications/mine/read')
      .set('Authorization', bearer(client.token));
    expect(clientMark.body.data.updatedCount).toBe(0);

    const otherCoachMark = await api()
      .patch('/api/v1/notifications/mine/read')
      .set('Authorization', bearer(otherCoach.token));
    expect(otherCoachMark.body.data.updatedCount).toBe(0);

    const coachMark = await api()
      .patch('/api/v1/notifications/mine/read')
      .set('Authorization', bearer(coach.token));
    expect(coachMark.body.data.updatedCount).toBe(1);

    const inbox = await api()
      .get('/api/v1/notifications/mine')
      .set('Authorization', bearer(coach.token));
    expect(inbox.body.data.unreadCount).toBe(0);
    expect(inbox.body.data.notifications[0]).toMatchObject({
      bookingId: created.body.data.id,
      readAt: expect.any(String),
    });
  });

  it('requires authentication and does not duplicate an alert when a booking is retried', async () => {
    const coach = await createCoach();
    const client = await registerUser();
    const window = bookingWindow(1, 10);

    const unauthenticated = await api().get('/api/v1/notifications/mine');
    expect(unauthenticated.status).toBe(401);

    const created = await requestBooking(client.token, coach.coachProfileId, window);
    expect(created.status).toBe(201);

    const retry = await requestBooking(client.token, coach.coachProfileId, window);
    expect(retry.status).toBe(409);
    const inbox = await api()
      .get('/api/v1/notifications/mine')
      .set('Authorization', bearer(coach.token));
    expect(inbox.body.data.unreadCount).toBe(1);
  });
});
