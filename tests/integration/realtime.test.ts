import http from 'node:http';

import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { initRealtime, type RealtimeServer } from '../../src/realtime/socket.js';
import { api, bearer, bookingWindow, createCoach, registerUser, requestBooking, uniqueEmail } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Realtime chat (Phase 3).
 *
 * Runs a real HTTP server + Socket.IO instance and drives it with real clients, so the
 * handshake authentication, room membership and fan-out are all exercised end to end.
 */
describe('Realtime chat', () => {
  let server: http.Server;
  let realtime: RealtimeServer;
  let port = 0;
  const openSockets: Socket[] = [];

  beforeAll(async () => {
    server = http.createServer(createApp());
    realtime = initRealtime(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.disconnect();
    }
    await realtime.close();
    await closeDatabase();
  });

  function connect(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
      });
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.on('connect', () => {
        clearTimeout(timer);
        openSockets.push(socket);
        resolve(socket);
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function emitWithAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve) => {
      socket.emit(event, payload, (response: T) => resolve(response));
    });
  }

  async function startConversation(token: string, participantId: string): Promise<string> {
    const response = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(token))
      .send({ participantId });
    return response.body.data.id as string;
  }

  it('rejects unauthenticated sockets', async () => {
    await expect(connect('not-a-valid-token')).rejects.toBeTruthy();
  });

  it('delivers a message to both participants in real time', async () => {
    const a = await registerUser({ email: uniqueEmail('rt-a') });
    const b = await registerUser({ email: uniqueEmail('rt-b') });
    const conversationId = await startConversation(a.token, b.id);

    const socketA = await connect(a.token);
    const socketB = await connect(b.token);

    expect(await emitWithAck<{ ok: boolean }>(socketA, 'conversation:join', { conversationId })).toMatchObject({ ok: true });
    expect(await emitWithAck<{ ok: boolean }>(socketB, 'conversation:join', { conversationId })).toMatchObject({ ok: true });

    const receivedByB = new Promise<{ body: string; conversationId: string }>((resolve) => {
      socketB.once('message:new', resolve);
    });

    const ack = await emitWithAck<{ ok: boolean; message: { body: string } }>(socketA, 'message:send', {
      conversationId,
      body: 'Realtime hello',
    });
    expect(ack.ok).toBe(true);

    const delivered = await receivedByB;
    expect(delivered.body).toBe('Realtime hello');
    expect(delivered.conversationId).toBe(conversationId);
  });

  it('delivers booking-linked HTTP messages only to sockets joined by booking participants', async () => {
    const coach = await createCoach();
    const client = await registerUser({ email: uniqueEmail('booking-chat-client') });
    const outsider = await registerUser({ email: uniqueEmail('booking-chat-outsider') });
    const booking = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10));
    const bookingId = booking.body.data.id as string;
    await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(coach.token));

    const opened = await api()
      .post(`/api/v1/conversations/booking/${bookingId}`)
      .set('Authorization', bearer(client.token))
      .send({});
    expect(opened.status).toBe(201);
    const conversationId = opened.body.data.id as string;

    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);
    const outsiderSocket = await connect(outsider.token);
    for (const socket of [clientSocket, coachSocket]) {
      expect(await emitWithAck<{ ok: boolean }>(socket, 'conversation:join', { conversationId })).toMatchObject({
        ok: true,
      });
    }
    expect(
      await emitWithAck<{ ok: boolean }>(outsiderSocket, 'conversation:join', { conversationId }),
    ).toMatchObject({ ok: false });

    const coachDelivery = new Promise<{ body: string; senderId: string }>((resolve) => {
      coachSocket.once('message:new', resolve);
    });
    let outsiderReceived = false;
    outsiderSocket.once('message:new', () => {
      outsiderReceived = true;
    });
    const posted = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(client.token))
      .send({ body: 'Please confirm our session.' });

    expect(posted.status).toBe(201);
    await expect(coachDelivery).resolves.toMatchObject({
      body: 'Please confirm our session.',
      senderId: client.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outsiderReceived).toBe(false);
  });

  it('delivers a booking alert to the authenticated coach only', async () => {
    const coach = await createCoach();
    const otherCoach = await createCoach({ email: uniqueEmail('rt-other-coach') });
    const client = await registerUser();
    const coachSocket = await connect(coach.token);
    const otherSocket = await connect(otherCoach.token);
    let otherCoachReceived = false;
    otherSocket.on('notification:new', () => {
      otherCoachReceived = true;
    });

    const delivered = new Promise<{ bookingId: string; type: string }>((resolve) => {
      coachSocket.once('notification:new', resolve);
    });
    const created = await requestBooking(client.token, coach.coachProfileId, bookingWindow(1, 10));
    expect(created.status).toBe(201);

    await expect(delivered).resolves.toMatchObject({
      bookingId: created.body.data.id,
      type: 'BOOKING_REQUEST',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherCoachReceived).toBe(false);
  });

  it('refuses to join a conversation the socket user is not part of', async () => {
    const a = await registerUser({ email: uniqueEmail('rt-a') });
    const b = await registerUser({ email: uniqueEmail('rt-b') });
    const outsider = await registerUser({ email: uniqueEmail('rt-out') });
    const conversationId = await startConversation(a.token, b.id);

    const outsiderSocket = await connect(outsider.token);
    const ack = await emitWithAck<{ ok: boolean }>(outsiderSocket, 'conversation:join', { conversationId });
    expect(ack.ok).toBe(false);
  });

  it('refuses to send a message over a socket the user is not allowed to use', async () => {
    const a = await registerUser({ email: uniqueEmail('rt-a') });
    const b = await registerUser({ email: uniqueEmail('rt-b') });
    const outsider = await registerUser({ email: uniqueEmail('rt-out') });
    const conversationId = await startConversation(a.token, b.id);

    const outsiderSocket = await connect(outsider.token);
    const ack = await emitWithAck<{ ok: boolean }>(outsiderSocket, 'message:send', {
      conversationId,
      body: 'Should not arrive',
    });
    expect(ack.ok).toBe(false);
  });
});
