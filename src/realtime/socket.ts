import type { Server as HttpServer } from 'node:http';

import { Server } from 'socket.io';
import { z } from 'zod';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  callIdSchema,
  callSignalSchema,
  inviteCallSchema,
} from '../schemas/call.schema.js';
import {
  acceptCall,
  endActiveCallsForUser,
  endCall,
  forViewer,
  getRingTimeoutMs,
  markCallMissed,
  reconcileStaleCalls,
  rejectCall,
  resolveSignalPeer,
  startCall,
} from '../services/call.service.js';
import { ensureMembership, sendMessage } from '../services/chat.service.js';
import { ApiError } from '../utils/errors.js';
import { verifyAccessToken, type AuthenticatedUser } from '../utils/jwt.js';
import type { BookingNotificationResponse, CallResponse, MessageResponse } from '../utils/presenters.js';

/**
 * Realtime chat + call signalling over Socket.IO.
 *
 * The transport is deliberately thin: every rule (membership, blocking, validation,
 * length limits, call lifecycle, duplicate-call prevention) is enforced by
 * `chat.service` / `call.service`, so a socket event and its REST equivalent can never
 * diverge. Sockets only add fan-out.
 *
 * Authentication uses the same JWT as the REST API, passed as
 * `io(url, { auth: { token } })`. Unauthenticated or expired sockets are rejected
 * before `connection` fires. Every socket joins a private `user:<id>` room, which is
 * the only channel a call event is delivered on - a client can never choose who
 * receives its signalling.
 */

export interface RealtimeServer {
  io: Server;
  /** Fan a newly persisted message out to everyone in the conversation. */
  emitNewMessage: (conversationId: string, message: MessageResponse) => void;
  /** Deliver a persisted notification only to the authenticated recipient's sockets. */
  emitNewNotification: (recipientUserId: string, notification: BookingNotificationResponse) => void;
  close: () => Promise<void>;
}

const sendMessagePayloadSchema = z.object({
  conversationId: z.uuid(),
  body: z.string().trim().min(1).max(4000),
});

const joinPayloadSchema = z.object({ conversationId: z.uuid() });

const conversationRoom = (conversationId: string): string => `conversation:${conversationId}`;
const userRoom = (userId: string): string => `user:${userId}`;

/** The process-wide realtime handle, or null when no HTTP server is running (tests). */
let current: RealtimeServer | null = null;

export function getRealtime(): RealtimeServer | null {
  return current;
}

/** Attach Socket.IO to the HTTP server. Returns a handle used by REST for fan-out. */
export function initRealtime(server: HttpServer): RealtimeServer {
  const io = new Server(server, {
    path: '/socket.io',
    cors: {
      origin: env.corsOrigins.includes('*') ? true : [...env.corsOrigins],
      credentials: true,
    },
  });

  // Close out calls left RINGING/ACCEPTED by a previous process, otherwise the partial
  // unique index would block every future call in those conversations.
  void reconcileStaleCalls()
    .then((count) => {
      if (count > 0) {
        logger.warn({ count }, 'marked stale calls as missed after restart');
      }
    })
    .catch((error: unknown) => logger.warn({ err: error }, 'could not reconcile stale calls'));

  // --- Authentication -----------------------------------------------------
  io.use((socket, next) => {
    const handshakeToken =
      (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
      extractToken(socket.handshake.headers.authorization);

    if (typeof handshakeToken !== 'string' || handshakeToken.length === 0) {
      next(new Error('UNAUTHORIZED'));
      return;
    }

    try {
      const payload = verifyAccessToken(handshakeToken);
      (socket.data as { user?: AuthenticatedUser }).user = {
        id: payload.sub,
        role: payload.role,
        email: payload.email,
      };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket.data as { user?: AuthenticatedUser }).user;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    logger.debug({ userId: user.id, socketId: socket.id }, 'socket connected');
    void socket.join(userRoom(user.id));

    socket.on('conversation:join', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = joinPayloadSchema.parse(rawPayload);
        await ensureMembership(user.id, payload.conversationId);
        await socket.join(conversationRoom(payload.conversationId));
        ack?.({ ok: true, conversationId: payload.conversationId });
      } catch (error) {
        ack?.({ ok: false, error: errorMessage(error) });
      }
    });

    socket.on('message:send', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = sendMessagePayloadSchema.parse(rawPayload);
        const message = await sendMessage(user.id, payload.conversationId, payload.body);
        // Broadcast to every participant's sockets, including the sender's other tabs.
        emitNewMessage(payload.conversationId, message);
        ack?.({ ok: true, message });
      } catch (error) {
        ack?.({ ok: false, error: errorMessage(error) });
      }
    });

    // --- Call signalling ----------------------------------------------------
    // Each handler defers every rule to `call.service`; the socket layer only fans out
    // to the two participants' private rooms.

    socket.on('call:invite', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = inviteCallSchema.parse(rawPayload);
        const result = await startCall(user.id, payload);
        scheduleRingTimeout(result.call.id);
        emitToUser(result.calleeId, 'call:incoming', { call: forViewer(result.call, result.calleeId) });
        ack?.({ ok: true, call: result.call });
      } catch (error) {
        ack?.({ ok: false, error: callErrorMessage(error, 'The call could not be started') });
      }
    });

    socket.on('call:accept', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = callIdSchema.parse(rawPayload);
        const result = await acceptCall(user.id, payload);
        clearRingTimeout(result.call.id);
        emitCallTransition('call:accepted', result);
        ack?.({ ok: true, call: forViewer(result.call, user.id) });
      } catch (error) {
        ack?.({ ok: false, error: callErrorMessage(error, 'The call could not be answered') });
      }
    });

    socket.on('call:reject', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = callIdSchema.parse(rawPayload);
        const result = await rejectCall(user.id, payload);
        clearRingTimeout(result.call.id);
        emitCallTransition('call:rejected', result);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: callErrorMessage(error, 'The call could not be declined') });
      }
    });

    socket.on('call:end', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = callIdSchema.parse(rawPayload);
        const result = await endCall(user.id, payload);
        clearRingTimeout(result.call.id);
        emitCallTransition('call:ended', result);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: callErrorMessage(error, 'The call could not be ended') });
      }
    });

    socket.on('call:signal', async (rawPayload: unknown, ack?: (response: unknown) => void) => {
      try {
        const payload = callSignalSchema.parse(rawPayload);
        const { peerUserId, callId } = resolveSignalPeer(user.id, payload);
        // Relayed verbatim (never persisted, never logged) straight to the peer's sockets.
        emitToUser(peerUserId, 'call:signal', { callId, kind: payload.kind, data: payload.data, from: user.id });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: callErrorMessage(error, 'The signal could not be relayed') });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: user.id, socketId: socket.id, reason }, 'socket disconnected');
      void handleDisconnect(user.id);
    });
  });

  function emitNewMessage(conversationId: string, message: MessageResponse): void {
    io.to(conversationRoom(conversationId)).emit('message:new', message);
  }

  function emitNewNotification(recipientUserId: string, notification: BookingNotificationResponse): void {
    io.to(userRoom(recipientUserId)).emit('notification:new', notification);
  }

  function emitToUser(userId: string, event: string, payload: unknown): void {
    io.to(userRoom(userId)).emit(event, payload);
  }

  /** Send one transition to both participants, each with its own `direction`. */
  function emitCallTransition(
    event: 'call:accepted' | 'call:rejected' | 'call:ended',
    result: { call: CallResponse; callerId: string; calleeId: string },
  ): void {
    for (const participantId of new Set([result.callerId, result.calleeId])) {
      emitToUser(participantId, event, { call: forViewer(result.call, participantId) });
    }
  }

  // --- Ring timeouts ------------------------------------------------------
  // Kept here (not in the service) because it is pure transport-side scheduling: the
  // service decides the timeout length, this only fires the transition + broadcast.
  const ringTimers = new Map<string, NodeJS.Timeout>();

  function scheduleRingTimeout(callId: string): void {
    clearRingTimeout(callId);
    const timer = setTimeout(() => {
      ringTimers.delete(callId);
      void markCallMissed(callId)
        .then((result) => {
          if (result) {
            emitCallTransition('call:ended', result);
          }
        })
        .catch((error: unknown) => logger.warn({ err: error, callId }, 'ring timeout failed'));
    }, getRingTimeoutMs());
    timer.unref?.();
    ringTimers.set(callId, timer);
  }

  function clearRingTimeout(callId: string): void {
    const timer = ringTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      ringTimers.delete(callId);
    }
  }

  /** A user with no sockets left is unreachable: end or cancel their live call. */
  async function handleDisconnect(userId: string): Promise<void> {
    try {
      const stillConnected = await io.in(userRoom(userId)).fetchSockets();
      if (stillConnected.length > 0) {
        return;
      }
      const results = await endActiveCallsForUser(userId);
      for (const result of results) {
        clearRingTimeout(result.call.id);
        emitCallTransition('call:ended', result);
      }
    } catch (error) {
      logger.warn({ err: error, userId }, 'could not clean up calls after disconnect');
    }
  }

  const handle: RealtimeServer = {
    io,
    emitNewMessage,
    emitNewNotification,
    close: async () => {
      for (const timer of ringTimers.values()) {
        clearTimeout(timer);
      }
      ringTimers.clear();
      await io.close();
      current = null;
    },
  };
  current = handle;
  return handle;
}

function extractToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'Invalid message payload';
  }
  return 'Message could not be sent';
}

/**
 * Like `errorMessage`, but for call events: exposes the ApiError message (safe, written
 * for end users) and never leaks internals for unexpected failures.
 */
function callErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'Invalid call payload';
  }
  return fallback;
}
