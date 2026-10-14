import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  api,
  bearer,
  bookingWindow,
  createCoach,
  registerUser,
  requestBooking,
  uniqueEmail,
} from '../helpers/api.js';
import { closeDatabase, prisma, resetDatabase } from '../helpers/database.js';

/**
 * Private chat (Phase 3).
 *
 * Membership and blocking are re-checked on every request, so these tests focus on the
 * boundaries: who can read or write a conversation, and what a block does mid-thread.
 */
describe('Chat', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function startConversation(token: string, participantId: string) {
    return api().post('/api/v1/conversations').set('Authorization', bearer(token)).send({ participantId });
  }

  it('requires authentication', async () => {
    expect((await api().get('/api/v1/conversations')).status).toBe(401);
    expect((await api().post('/api/v1/conversations').send({ participantId: 'x' })).status).toBe(401);
  });

  it('starts a conversation idempotently', async () => {
    const a = await registerUser({ email: uniqueEmail('chat-a') });
    const b = await registerUser({ email: uniqueEmail('chat-b') });

    const first = await startConversation(a.token, b.id);
    expect(first.status).toBe(201);
    expect(first.body.data.participant.id).toBe(b.id);
    expect(first.body.data.lastMessage).toBeNull();

    const second = await startConversation(a.token, b.id);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    // The other participant sees the same conversation from their side.
    const bView = await startConversation(b.token, a.id);
    expect(bView.body.data.id).toBe(first.body.data.id);
    expect(bView.body.data.participant.id).toBe(a.id);
  });

  it('opens one shared conversation only for an accepted booking and persists both participants’ messages', async () => {
    const coach = await createCoach();
    const client = await registerUser();
    const outsider = await registerUser({ email: uniqueEmail('chat-outsider') });
    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10));
    const bookingId = created.body.data.id as string;
    const endpoint = `/api/v1/conversations/booking/${bookingId}`;

    expect((await api().post('/api/v1/conversations/booking/not-a-uuid').set('Authorization', bearer(client.token))).status).toBe(400);
    expect(
      (
        await api()
          .post('/api/v1/conversations/booking/00000000-0000-0000-0000-000000000000')
          .set('Authorization', bearer(client.token))
      ).status,
    ).toBe(404);
    expect((await api().post(endpoint).set('Authorization', bearer(client.token)).send({})).status).toBe(409);

    await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(coach.token));

    const openedByClient = await api()
      .post(endpoint)
      .set('Authorization', bearer(client.token))
      .send({ coachUserId: outsider.id });
    expect(openedByClient.status).toBe(201);
    expect(openedByClient.body.data.participant.id).toBe(coach.id);

    const openedByCoach = await api().post(endpoint).set('Authorization', bearer(coach.token)).send({});
    expect(openedByCoach.status).toBe(201);
    expect(openedByCoach.body.data.id).toBe(openedByClient.body.data.id);
    expect(openedByCoach.body.data.participant.id).toBe(client.id);

    const conversation = await prisma.conversation.findUnique({
      where: { bookingId },
      include: { participants: { select: { userId: true } } },
    });
    expect(conversation?.participants.map(({ userId }) => userId).sort()).toEqual([client.id, coach.id].sort());

    const unauthorizedOpen = await api().post(endpoint).set('Authorization', bearer(outsider.token)).send({});
    expect(unauthorizedOpen.status).toBe(403);

    const conversationId = openedByClient.body.data.id as string;
    const sent = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(client.token))
      .send({ body: 'Hello coach' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.senderId).toBe(client.id);

    const coachHistory = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(coach.token));
    expect(coachHistory.body.data.map((message: { body: string }) => message.body)).toEqual(['Hello coach']);
    const coachInbox = await api().get('/api/v1/conversations').set('Authorization', bearer(coach.token));
    expect(coachInbox.body.data[0].unreadCount).toBe(1);

    const read = await api()
      .patch(`/api/v1/conversations/${conversationId}/read`)
      .set('Authorization', bearer(coach.token));
    expect(read.status).toBe(200);
    const readInbox = await api().get('/api/v1/conversations').set('Authorization', bearer(coach.token));
    expect(readInbox.body.data[0].unreadCount).toBe(0);

    const reply = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(coach.token))
      .send({ body: 'See you soon' });
    expect(reply.status).toBe(201);

    const refreshedHistory = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(client.token));
    expect(refreshedHistory.body.data.map((message: { body: string }) => message.body)).toEqual([
      'Hello coach',
      'See you soon',
    ]);

    const unauthorizedRead = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(outsider.token));
    expect(unauthorizedRead.status).toBe(403);
  });

  it('does not open or continue a booking conversation after the booking is cancelled', async () => {
    const coach = await createCoach();
    const client = await registerUser();
    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10));
    const bookingId = created.body.data.id as string;

    expect(
      (await api().post(`/api/v1/conversations/booking/${bookingId}`).set('Authorization', bearer(client.token)).send({}))
        .status,
    ).toBe(409);

    await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(coach.token));
    const opened = await api()
      .post(`/api/v1/conversations/booking/${bookingId}`)
      .set('Authorization', bearer(client.token))
      .send({});
    const conversationId = opened.body.data.id as string;

    await api().patch(`/api/v1/bookings/${bookingId}/cancel`).set('Authorization', bearer(client.token));
    const send = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(client.token))
      .send({ body: 'This should be blocked' });
    expect(send.status).toBe(409);
  });

  it('keeps the same conversation available after the coach completes the booking', async () => {
    const coach = await createCoach();
    const client = await registerUser();
    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10));
    const bookingId = created.body.data.id as string;

    await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(coach.token));
    const initial = await api()
      .post(`/api/v1/conversations/booking/${bookingId}`)
      .set('Authorization', bearer(client.token))
      .send({});
    expect(initial.status).toBe(201);

    await api().patch(`/api/v1/bookings/${bookingId}/complete`).set('Authorization', bearer(coach.token));
    const reopened = await api()
      .post(`/api/v1/conversations/booking/${bookingId}`)
      .set('Authorization', bearer(coach.token))
      .send({});
    expect(reopened.status).toBe(201);
    expect(reopened.body.data.id).toBe(initial.body.data.id);
  });

  it('rejects self-conversations and unknown participants', async () => {
    const a = await registerUser();
    expect((await startConversation(a.token, a.id)).status).toBe(400);
    expect((await startConversation(a.token, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('sends and lists messages oldest-first', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(a.token))
      .send({ body: 'First message' });
    await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(b.token))
      .send({ body: 'Second message' });

    const history = await api()
      .get(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(a.token));

    expect(history.status).toBe(200);
    expect(history.body.data.map((m: { body: string }) => m.body)).toEqual(['First message', 'Second message']);
    expect(history.body.meta.total).toBe(2);
  });

  it('paginates conversation history', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    for (let index = 1; index <= 5; index += 1) {
      await api()
        .post(`/api/v1/conversations/${conversation}/messages`)
        .set('Authorization', bearer(a.token))
        .send({ body: `Message ${index}` });
      // Distinct created_at values make the expected page deterministic.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // History is returned oldest-first; page 2 of a newest-first query is messages 2-3.
    const page = await api()
      .get(`/api/v1/conversations/${conversation}/messages?page=2&limit=2`)
      .set('Authorization', bearer(a.token));

    expect(page.body.data.map((m: { body: string }) => m.body)).toEqual(['Message 2', 'Message 3']);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3, hasNextPage: true });
  });

  it('forbids non-members from reading or writing a conversation', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const outsider = await registerUser({ email: uniqueEmail('outsider') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    const read = await api()
      .get(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(outsider.token));
    expect(read.status).toBe(403);

    const write = await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(outsider.token))
      .send({ body: 'Sneaking in' });
    expect(write.status).toBe(403);
  });

  it('validates the message body', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    const empty = await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(a.token))
      .send({ body: '   ' });
    expect(empty.status).toBe(400);

    const tooLong = await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(a.token))
      .send({ body: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
  });

  it('tracks unread counts and clears them when the conversation is read', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(a.token))
      .send({ body: 'Hello there' });

    const inboxB = await api().get('/api/v1/conversations').set('Authorization', bearer(b.token));
    expect(inboxB.body.data[0].unreadCount).toBe(1);
    expect(inboxB.body.data[0].lastMessage.body).toBe('Hello there');

    const read = await api()
      .patch(`/api/v1/conversations/${conversation}/read`)
      .set('Authorization', bearer(b.token));
    expect(read.status).toBe(200);

    const inboxAfter = await api().get('/api/v1/conversations').set('Authorization', bearer(b.token));
    expect(inboxAfter.body.data[0].unreadCount).toBe(0);
  });

  it('stops blocked users from messaging each other', async () => {
    const a = await registerUser();
    const b = await registerUser({ email: uniqueEmail('chat-b') });
    const conversation = (await startConversation(a.token, b.id)).body.data.id;

    await api()
      .post('/api/v1/blocks')
      .set('Authorization', bearer(a.token))
      .send({ userId: b.id });

    const sendAfterBlock = await api()
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set('Authorization', bearer(b.token))
      .send({ body: 'Can you see this?' });
    expect(sendAfterBlock.status).toBe(403);

    const startAfterBlock = await startConversation(b.token, a.id);
    expect(startAfterBlock.status).toBe(403);
  });
});
