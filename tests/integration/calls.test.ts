import http from 'node:http';

import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { initRealtime, type RealtimeServer } from '../../src/realtime/socket.js';
import { resetActiveCalls } from '../../src/services/call.service.js';
import {
  api,
  bearer,
  bookingWindow,
  createCoach,
  registerUser,
  requestBooking,
  uniqueEmail,
  type TestCoach,
  type TestUser,
} from '../helpers/api.js';
import { closeDatabase, prisma, resetDatabase } from '../helpers/database.js';

/**
 * Audio / video calls (WebRTC signalling).
 *
 * Runs a real HTTP server + Socket.IO instance and drives it with real clients, so
 * handshake authentication, membership/relationship authorization, room targeting and
 * the call lifecycle are all exercised end to end. TURN is intentionally unconfigured
 * in tests (no media is ever negotiated here).
 */
describe('Call signalling', () => {
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
    // The active-call registry is in-process state; clear it so each test starts clean.
    resetActiveCalls();
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.disconnect();
    }
    await realtime.close();
    await closeDatabase();
  });

  // --- Helpers --------------------------------------------------------------

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

  /** Resolve with the first matching event, or reject if it never arrives. */
  function nextEvent<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  interface CallPayload {
    id: string;
    conversationId: string;
    type: string;
    status: string;
    direction: string;
    caller: { id: string };
    callee: { id: string };
    endedById: string | null;
  }

  /** A coach + client with an accepted booking and its shared conversation. */
  async function callableConversation(
    coach?: TestCoach,
    client?: TestUser,
    window = bookingWindow(2, 11),
  ): Promise<{ coach: TestCoach; client: TestUser; bookingId: string; conversationId: string }> {
    const resolvedCoach = coach ?? (await createCoach());
    const resolvedClient = client ?? (await registerUser({ email: uniqueEmail('call-client') }));

    const created = await requestBooking(resolvedClient.token, resolvedCoach.coachProfileId, window);
    const bookingId = created.body.data.id as string;
    await api().patch(`/api/v1/bookings/${bookingId}/accept`).set('Authorization', bearer(resolvedCoach.token));

    const opened = await api()
      .post(`/api/v1/conversations/booking/${bookingId}`)
      .set('Authorization', bearer(resolvedClient.token))
      .send({});
    return { coach: resolvedCoach, client: resolvedClient, bookingId, conversationId: opened.body.data.id as string };
  }

  /** Invite and resolve with the call id (invite ack + callee delivery asserted). */
  async function startCall(socket: Socket, conversationId: string, type: 'AUDIO' | 'VIDEO'): Promise<string> {
    const ack = await emitWithAck<{ ok: boolean; call: CallPayload }>(socket, 'call:invite', {
      conversationId,
      type,
    });
    expect(ack.ok).toBe(true);
    return ack.call.id;
  }

  // --- REST: ICE configuration ---------------------------------------------

  it('requires authentication for the ICE configuration', async () => {
    expect((await api().get('/api/v1/calls/config')).status).toBe(401);
  });

  it('serves ICE servers and the ring timeout, without leaking TURN secrets', async () => {
    const user = await registerUser();
    const response = await api().get('/api/v1/calls/config').set('Authorization', bearer(user.token));

    expect(response.status).toBe(200);
    expect(response.body.data.iceServers).toEqual(expect.any(Array));
    expect(response.body.data.ringTimeoutMs).toBeGreaterThanOrEqual(5000);

    if (process.env.TURN_SHARED_SECRET) {
      expect(JSON.stringify(response.body)).not.toContain(process.env.TURN_SHARED_SECRET);
    }
  });

  // --- Authorization --------------------------------------------------------

  it('delivers an incoming call to the callee only', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const outsider = await registerUser({ email: uniqueEmail('call-outsider') });

    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);
    const outsiderSocket = await connect(outsider.token);

    let outsiderSawCall = false;
    outsiderSocket.on('call:incoming', () => {
      outsiderSawCall = true;
    });

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const ack = await emitWithAck<{ ok: boolean; call: CallPayload }>(clientSocket, 'call:invite', {
      conversationId,
      type: 'VIDEO',
    });

    expect(ack.ok).toBe(true);
    expect(ack.call).toMatchObject({ status: 'RINGING', direction: 'OUTGOING', type: 'VIDEO' });

    const delivered = await incoming;
    expect(delivered.call).toMatchObject({ id: ack.call.id, status: 'RINGING', direction: 'INCOMING' });
    expect(delivered.call.caller.id).toBe(client.id);
    expect(delivered.call.callee.id).toBe(coach.id);

    await delay(60);
    expect(outsiderSawCall).toBe(false);

    const stored = await prisma.call.findUnique({ where: { id: ack.call.id } });
    expect(stored?.status).toBe('RINGING');
    expect(stored?.answeredAt).toBeNull();
    expect(stored?.endedAt).toBeNull();
  });

  it('refuses an invite from a user who is not a participant', async () => {
    const { conversationId } = await callableConversation();
    const outsider = await registerUser({ email: uniqueEmail('call-outsider') });
    const outsiderSocket = await connect(outsider.token);

    const ack = await emitWithAck<{ ok: boolean }>(outsiderSocket, 'call:invite', {
      conversationId,
      type: 'AUDIO',
    });
    expect(ack.ok).toBe(false);
  });

  it('refuses calls outside a booking conversation', async () => {
    const a = await registerUser({ email: uniqueEmail('call-a') });
    const b = await registerUser({ email: uniqueEmail('call-b') });

    const started = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(a.token))
      .send({ participantId: b.id });
    const conversationId = started.body.data.id as string;

    const socket = await connect(a.token);
    const ack = await emitWithAck<{ ok: boolean; error: string }>(socket, 'call:invite', {
      conversationId,
      type: 'AUDIO',
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/booking/i);
  });

  it('re-checks authorization: a cancelled booking can no longer be called', async () => {
    const { client, conversationId, bookingId } = await callableConversation();
    await api().patch(`/api/v1/bookings/${bookingId}/cancel`).set('Authorization', bearer(client.token));

    const socket = await connect(client.token);
    const ack = await emitWithAck<{ ok: boolean }>(socket, 'call:invite', { conversationId, type: 'AUDIO' });
    expect(ack.ok).toBe(false);
  });

  it('refuses to connect a blocked pair', async () => {
    const { coach, client, conversationId } = await callableConversation();
    await api().post('/api/v1/blocks').set('Authorization', bearer(client.token)).send({ userId: coach.id });

    const socket = await connect(client.token);
    const ack = await emitWithAck<{ ok: boolean; error: string }>(socket, 'call:invite', {
      conversationId,
      type: 'AUDIO',
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/cannot call this user/i);
  });

  // --- Lifecycle ------------------------------------------------------------

  it('accepts a call, relays signalling between the two participants, then ends it', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'AUDIO');
    await incoming;

    const accepted = nextEvent<{ call: CallPayload }>(clientSocket, 'call:accepted');
    const acceptAck = await emitWithAck<{ ok: boolean }>(coachSocket, 'call:accept', { callId });
    expect(acceptAck.ok).toBe(true);

    const acceptedPayload = await accepted;
    expect(acceptedPayload.call).toMatchObject({ id: callId, status: 'ACCEPTED', direction: 'OUTGOING' });

    // An unanswered/incorrect signal must not be relayed.
    const signalReceived = nextEvent<{ callId: string; kind: string; data: unknown; from: string }>(
      coachSocket,
      'call:signal',
    );
    const signalAck = await emitWithAck<{ ok: boolean }>(clientSocket, 'call:signal', {
      callId,
      kind: 'offer',
      data: { sdp: 'v=0 test offer' },
    });
    expect(signalAck.ok).toBe(true);
    const relayed = await signalReceived;
    expect(relayed).toMatchObject({ callId, kind: 'offer', from: client.id });
    expect(relayed.data).toEqual({ sdp: 'v=0 test offer' });

    const endedForClient = nextEvent<{ call: CallPayload }>(clientSocket, 'call:ended');
    const endedForCoach = nextEvent<{ call: CallPayload }>(coachSocket, 'call:ended');
    const endAck = await emitWithAck<{ ok: boolean }>(clientSocket, 'call:end', { callId });
    expect(endAck.ok).toBe(true);
    await Promise.all([endedForClient, endedForCoach]);

    const stored = await prisma.call.findUnique({ where: { id: callId } });
    expect(stored).toMatchObject({ status: 'ENDED', endedById: client.id });
    expect(stored?.answeredAt).not.toBeNull();
    expect(stored?.endedAt).not.toBeNull();
  });

  it('records a declined call and notifies the caller', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'VIDEO');
    await incoming;

    const rejected = nextEvent<{ call: CallPayload }>(clientSocket, 'call:rejected');
    const rejectAck = await emitWithAck<{ ok: boolean }>(coachSocket, 'call:reject', { callId });
    expect(rejectAck.ok).toBe(true);

    const payload = await rejected;
    expect(payload.call).toMatchObject({ id: callId, status: 'REJECTED', direction: 'OUTGOING' });

    const stored = await prisma.call.findUnique({ where: { id: callId } });
    expect(stored).toMatchObject({ status: 'REJECTED', endedById: coach.id });
    expect(stored?.answeredAt).toBeNull();
    expect(stored?.endedAt).not.toBeNull();
  });

  it('refuses a signal for a call the user is not part of', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const outsider = await registerUser({ email: uniqueEmail('call-outsider') });
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);
    const outsiderSocket = await connect(outsider.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'AUDIO');
    await incoming;

    const ack = await emitWithAck<{ ok: boolean }>(outsiderSocket, 'call:signal', {
      callId,
      kind: 'candidate',
      data: { candidate: 'x' },
    });
    expect(ack.ok).toBe(false);
  });

  // --- Concurrency ----------------------------------------------------------

  it('prevents a second concurrent call for the same participants', async () => {
    const coach = await createCoach();
    const client = await registerUser({ email: uniqueEmail('call-client') });

    const first = await callableConversation(coach, client, bookingWindow(2, 11));
    const second = await callableConversation(coach, client, bookingWindow(3, 13));

    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);
    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    await startCall(clientSocket, first.conversationId, 'AUDIO');
    await incoming;

    // The caller is already in a call.
    const busyCaller = await emitWithAck<{ ok: boolean; error: string }>(clientSocket, 'call:invite', {
      conversationId: second.conversationId,
      type: 'AUDIO',
    });
    expect(busyCaller.ok).toBe(false);
    expect(busyCaller.error).toMatch(/already in a call/i);

    // A third party cannot call the busy callee either.
    const client2 = await registerUser({ email: uniqueEmail('call-client-2') });
    const third = await callableConversation(coach, client2, bookingWindow(4, 15));
    const thirdSocket = await connect(client2.token);
    const busyCallee = await emitWithAck<{ ok: boolean }>(thirdSocket, 'call:invite', {
      conversationId: third.conversationId,
      type: 'AUDIO',
    });
    expect(busyCallee.ok).toBe(false);
  });

  // --- Timeouts and disconnects --------------------------------------------

  it('marks a call as missed when nobody answers', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'AUDIO');
    await incoming;

    // The ring timeout is 5000 ms in tests (see tests/setup/setupFiles.ts).
    const missed = await nextEvent<{ call: CallPayload }>(coachSocket, 'call:ended', 15000);
    expect(missed.call).toMatchObject({ id: callId, status: 'MISSED' });

    const stored = await prisma.call.findUnique({ where: { id: callId } });
    expect(stored?.status).toBe('MISSED');
    expect(stored?.endedAt).not.toBeNull();
  }, 20000);

  it('cancels a ringing call when the caller disconnects', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'AUDIO');
    await incoming;

    const ended = nextEvent<{ call: CallPayload }>(coachSocket, 'call:ended');
    clientSocket.disconnect();

    const payload = await ended;
    expect(payload.call).toMatchObject({ id: callId, status: 'CANCELLED' });

    const stored = await prisma.call.findUnique({ where: { id: callId } });
    expect(stored?.status).toBe('CANCELLED');
  });

  it('ends a connected call when either participant disconnects', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'AUDIO');
    await incoming;

    await emitWithAck(coachSocket, 'call:accept', { callId });

    // The disconnecting socket leaves its room, so the *other* participant observes it.
    const endedForClient = nextEvent<{ call: CallPayload }>(clientSocket, 'call:ended');
    coachSocket.disconnect();

    const payload = await endedForClient;
    expect(payload.call).toMatchObject({ id: callId, status: 'ENDED' });

    const stored = await prisma.call.findUnique({ where: { id: callId } });
    expect(stored?.status).toBe('ENDED');
    expect(stored?.endedAt).not.toBeNull();
  });

  // --- History --------------------------------------------------------------

  it('returns the conversation call log to members only', async () => {
    const { coach, client, conversationId } = await callableConversation();
    const outsider = await registerUser({ email: uniqueEmail('call-outsider') });
    const clientSocket = await connect(client.token);
    const coachSocket = await connect(coach.token);

    const incoming = nextEvent<{ call: CallPayload }>(coachSocket, 'call:incoming');
    const callId = await startCall(clientSocket, conversationId, 'VIDEO');
    await incoming;
    await emitWithAck(coachSocket, 'call:reject', { callId });

    const clientLog = await api()
      .get(`/api/v1/conversations/${conversationId}/calls`)
      .set('Authorization', bearer(client.token));
    expect(clientLog.status).toBe(200);
    expect(clientLog.body.data[0]).toMatchObject({ id: callId, direction: 'OUTGOING', status: 'REJECTED' });
    expect(clientLog.body.meta.total).toBe(1);

    const coachLog = await api()
      .get(`/api/v1/conversations/${conversationId}/calls`)
      .set('Authorization', bearer(coach.token));
    expect(coachLog.body.data[0].direction).toBe('INCOMING');

    const forbidden = await api()
      .get(`/api/v1/conversations/${conversationId}/calls`)
      .set('Authorization', bearer(outsider.token));
    expect(forbidden.status).toBe(403);
  });
});
