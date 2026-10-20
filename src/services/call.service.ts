import { createHmac, randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import type { CallStatus } from '../generated/prisma/enums.js';
import type { CallIdPayload, CallSignalPayload, InviteCallPayload, ListCallsQuery } from '../schemas/call.schema.js';
import { ApiError } from '../utils/errors.js';
import { toCallResponse, type CallConfigResponse, type CallResponse, type IceServerResponse } from '../utils/presenters.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';
import { isBlockedBetween } from './block.service.js';
import { ensureMembership } from './chat.service.js';

/**
 * Audio / video call service.
 *
 * Responsibilities:
 *  - **Authorization**: a call may only happen inside a booking conversation between
 *    its two participants (client + coach). Re-checked at invite *and* on every
 *    signalling event, so a stale call id is useless after a block or a cancelled
 *    booking.
 *  - **Lifecycle**: RINGING -> ACCEPTED -> ENDED, plus REJECTED / MISSED / CANCELLED.
 *  - **Concurrency**: at most one live call per user and per conversation, enforced in
 *    memory (single-instance deployment) and additionally by a partial unique index on
 *    `calls(conversation_id)` for the database-level race.
 *  - **ICE configuration**: builds STUN/TURN servers, minting time-limited TURN
 *    credentials so no long-lived secret reaches the browser.
 *
 * The service stores no media, SDP or ICE candidates: media is peer-to-peer and
 * signalling payloads are relayed without being persisted or logged.
 */

const CALL_INCLUDE = {
  caller: { select: { id: true, name: true, displayName: true, avatarUrl: true } },
  callee: { select: { id: true, name: true, displayName: true, avatarUrl: true } },
} as const;

/** A call that is currently RINGING or ACCEPTED. Terminal calls leave the registry. */
interface ActiveCall {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  status: 'RINGING' | 'ACCEPTED';
}

// --- In-memory registry -----------------------------------------------------
// Single-process deployment (no Redis adapter), so plain maps are the source of truth
// for *live* calls. The database remains the durable record and the cross-process
// safety net via its partial unique index.
const activeCalls = new Map<string, ActiveCall>();
const callByUser = new Map<string, string>();
const callByConversation = new Map<string, string>();

function reserve(call: ActiveCall): void {
  if (callByUser.has(call.callerId) || callByUser.has(call.calleeId)) {
    throw ApiError.conflict('One of the participants is already in a call');
  }
  if (callByConversation.has(call.conversationId)) {
    throw ApiError.conflict('This conversation already has an active call');
  }
  activeCalls.set(call.id, call);
  callByUser.set(call.callerId, call.id);
  callByUser.set(call.calleeId, call.id);
  callByConversation.set(call.conversationId, call.id);
}

function release(callId: string): void {
  const call = activeCalls.get(callId);
  if (!call) {
    return;
  }
  activeCalls.delete(callId);
  if (callByUser.get(call.callerId) === callId) {
    callByUser.delete(call.callerId);
  }
  if (callByUser.get(call.calleeId) === callId) {
    callByUser.delete(call.calleeId);
  }
  if (callByConversation.get(call.conversationId) === callId) {
    callByConversation.delete(call.conversationId);
  }
}

/**
 * Drop every registry entry (used by tests and by a graceful shutdown). Does not touch
 * the database; terminal states are persisted by the individual transition functions.
 */
export function resetActiveCalls(): void {
  activeCalls.clear();
  callByUser.clear();
  callByConversation.clear();
}

export function getRingTimeoutMs(): number {
  return env.CALL_RING_TIMEOUT_MS;
}

/** How long a dropped socket may stay away before the server ends the call. */
export function getDisconnectGraceMs(): number {
  return env.CALL_DISCONNECT_GRACE_MS;
}

/** Hard ceiling for a connected call; used by the stale-session sweep. */
export function getMaxCallDurationMs(): number {
  return env.CALL_MAX_DURATION_MINUTES * 60_000;
}

// --- Authorization ----------------------------------------------------------

/**
 * Resolve a booking conversation the caller is allowed to start a call in.
 *
 * `ensureMembership` already rejects non-members (403) and conversations whose booking
 * is not ACCEPTED/COMPLETED (409); on top of that, calls require a *booking* link (never
 * for open-ended direct conversations) and honour blocks even mid-thread.
 */
async function loadCallableConversation(
  userId: string,
  conversationId: string,
): Promise<{ otherUserId: string }> {
  await ensureMembership(userId, conversationId);

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { bookingId: true, participants: { select: { userId: true } } },
  });

  if (!conversation) {
    throw ApiError.notFound('Conversation not found');
  }
  if (!conversation.bookingId) {
    throw ApiError.forbidden('Calls are only available for booking conversations');
  }

  const other = conversation.participants.find((participant) => participant.userId !== userId);
  if (!other) {
    throw ApiError.notFound('Conversation has no other participant');
  }

  if (await isBlockedBetween(userId, other.userId)) {
    throw ApiError.forbidden('You cannot call this user');
  }

  return { otherUserId: other.userId };
}

/** The live call, or 409 when it is unknown/expired (e.g. after a restart). */
function requireActiveCall(callId: string): ActiveCall {
  const call = activeCalls.get(callId);
  if (!call) {
    throw ApiError.conflict('This call is no longer active');
  }
  return call;
}

function requireParticipant(call: ActiveCall, userId: string): void {
  if (userId !== call.callerId && userId !== call.calleeId) {
    // 404-style message: do not reveal which calls exist to a third party.
    throw ApiError.forbidden('You are not a participant in this call');
  }
}

// --- Lifecycle --------------------------------------------------------------

/**
 * Start a call. Returns the freshly created (RINGING) call plus both participant ids so
 * the transport can notify the callee.
 */
export async function startCall(
  userId: string,
  input: InviteCallPayload,
): Promise<{ call: CallResponse; callerId: string; calleeId: string }> {
  const { otherUserId } = await loadCallableConversation(userId, input.conversationId);

  const callId = randomUUID();
  // Reserve before the write: the checks and the reservation run without an `await`
  // between them, so two simultaneous invites cannot both pass.
  reserve({
    id: callId,
    conversationId: input.conversationId,
    callerId: userId,
    calleeId: otherUserId,
    status: 'RINGING',
  });

  try {
    const created = await prisma.call.create({
      data: {
        id: callId,
        conversationId: input.conversationId,
        callerId: userId,
        calleeId: otherUserId,
        type: input.type,
      },
      include: CALL_INCLUDE,
    });
    return { call: toCallResponse(created, userId), callerId: userId, calleeId: otherUserId };
  } catch (error) {
    release(callId);
    if (isUniqueConstraintViolation(error)) {
      throw ApiError.conflict('This conversation already has an active call');
    }
    throw error;
  }
}

/** Persist a terminal transition and free the registry slot. */
async function finalize(
  call: ActiveCall,
  status: Extract<CallStatus, 'REJECTED' | 'MISSED' | 'CANCELLED' | 'ENDED'>,
  endedById: string | null,
): Promise<CallResponse> {
  const updated = await prisma.call.update({
    where: { id: call.id },
    data: { status, endedAt: new Date(), endedById },
    include: CALL_INCLUDE,
  });
  release(call.id);
  return toCallResponse(updated, call.callerId);
}

/**
 * Re-point a call at a viewer.
 *
 * A `CallResponse` carries `direction` relative to one user, but the same transition is
 * broadcast to both participants. Callers use this to send each side its own view.
 */
export function forViewer(call: CallResponse, viewerId: string): CallResponse {
  return { ...call, direction: call.caller.id === viewerId ? 'OUTGOING' : 'INCOMING' };
}

/** Callee answers a ringing call. */
export async function acceptCall(
  userId: string,
  input: CallIdPayload,
): Promise<{ call: CallResponse; callerId: string; calleeId: string }> {
  const call = requireActiveCall(input.callId);
  requireParticipant(call, userId);

  if (userId !== call.calleeId) {
    throw ApiError.forbidden('Only the callee can answer this call');
  }
  if (call.status !== 'RINGING') {
    throw ApiError.conflict('This call is already in progress');
  }

  const updated = await prisma.call.update({
    where: { id: call.id },
    data: { status: 'ACCEPTED', answeredAt: new Date() },
    include: CALL_INCLUDE,
  });
  call.status = 'ACCEPTED';

  return { call: toCallResponse(updated, userId), callerId: call.callerId, calleeId: call.calleeId };
}

/** Callee declines a ringing call. */
export async function rejectCall(
  userId: string,
  input: CallIdPayload,
): Promise<{ call: CallResponse; callerId: string; calleeId: string }> {
  const call = requireActiveCall(input.callId);
  requireParticipant(call, userId);

  if (userId !== call.calleeId) {
    throw ApiError.forbidden('Only the callee can decline this call');
  }
  if (call.status !== 'RINGING') {
    throw ApiError.conflict('This call has already been answered');
  }

  return {
    call: await finalize(call, 'REJECTED', userId),
    callerId: call.callerId,
    calleeId: call.calleeId,
  };
}

/**
 * Hang up.
 *
 *  - caller hangs up while ringing  -> CANCELLED
 *  - callee hangs up while ringing  -> REJECTED (same meaning as decline)
 *  - either party hangs up connected -> ENDED
 */
export async function endCall(
  userId: string,
  input: CallIdPayload,
): Promise<{ call: CallResponse; callerId: string; calleeId: string }> {
  const call = requireActiveCall(input.callId);
  requireParticipant(call, userId);

  const status =
    call.status === 'ACCEPTED' ? 'ENDED' : userId === call.calleeId ? 'REJECTED' : 'CANCELLED';

  return {
    call: await finalize(call, status, userId),
    callerId: call.callerId,
    calleeId: call.calleeId,
  };
}

/** Nobody answered in time: record the call as MISSED. */
export async function markCallMissed(callId: string): Promise<{ call: CallResponse; callerId: string; calleeId: string } | null> {
  const call = activeCalls.get(callId);
  if (!call || call.status !== 'RINGING') {
    return null;
  }
  return {
    call: await finalize(call, 'MISSED', null),
    callerId: call.callerId,
    calleeId: call.calleeId,
  };
}

/**
 * Terminate every call a disconnecting socket user is part of. A caller who drops while
 * ringing cancels the call; a callee who drops never answered, so it is MISSED; either
 * party dropping mid-call ends it.
 */
export async function endActiveCallsForUser(
  userId: string,
): Promise<{ call: CallResponse; callerId: string; calleeId: string }[]> {
  const callId = callByUser.get(userId);
  const call = callId ? activeCalls.get(callId) : undefined;
  if (!call) {
    return [];
  }

  const status =
    call.status === 'ACCEPTED' ? 'ENDED' : userId === call.callerId ? 'CANCELLED' : 'MISSED';

  return [{ call: await finalize(call, status, userId), callerId: call.callerId, calleeId: call.calleeId }];
}

/** Whether the user is currently in a live call (used to avoid duplicate dialogs). */
export function getActiveCallIdForUser(userId: string): string | null {
  return callByUser.get(userId) ?? null;
}

/**
 * Authorize relaying one signalling payload between the two call participants.
 * Returns the peer to forward it to (never the sender's own sockets).
 */
export function resolveSignalPeer(userId: string, input: CallSignalPayload): { peerUserId: string; callId: string } {
  const call = requireActiveCall(input.callId);
  requireParticipant(call, userId);
  return { peerUserId: userId === call.callerId ? call.calleeId : call.callerId, callId: call.id };
}

// --- ICE / TURN configuration ----------------------------------------------

function splitUrls(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * RFC 5766 "TURN REST API" credentials: `<expiry>:<user>` signed with HMAC-SHA1.
 * Compatible with coturn (`use-auth-secret`) and providers such as Metered, so the
 * shared secret stays on the server and nobody ever holds a long-lived TURN password.
 */
function buildTurnCredentials(userId: string): { username: string; credential: string } {
  const username = `${Math.floor(Date.now() / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS}:${userId}`;
  const credential = createHmac('sha1', env.TURN_SHARED_SECRET as string).update(username).digest('base64');
  return { username, credential };
}

export function getIceServers(userId: string): IceServerResponse[] {
  const servers: IceServerResponse[] = [];

  const stunUrls = splitUrls(env.STUN_URLS);
  if (stunUrls.length > 0) {
    servers.push({ urls: stunUrls });
  }

  const turnUrls = splitUrls(env.TURN_URLS);
  if (turnUrls.length > 0) {
    if (env.TURN_SHARED_SECRET) {
      servers.push({ urls: turnUrls, ...buildTurnCredentials(userId) });
    } else {
      servers.push({
        urls: turnUrls,
        username: env.TURN_USERNAME as string,
        credential: env.TURN_CREDENTIAL as string,
      });
    }
  }

  return servers;
}

export function getCallConfig(userId: string): CallConfigResponse {
  return {
    iceServers: getIceServers(userId),
    ringTimeoutMs: getRingTimeoutMs(),
    disconnectGraceMs: getDisconnectGraceMs(),
  };
}

// --- History ----------------------------------------------------------------

/**
 * Call log for one conversation. Membership (and the booking still being usable) is
 * re-checked, exactly like reading messages.
 */
export async function listConversationCalls(
  userId: string,
  conversationId: string,
  query: ListCallsQuery,
): Promise<{ calls: CallResponse[]; total: number }> {
  await ensureMembership(userId, conversationId);

  const where = { conversationId };
  const [rows, total] = await prisma.$transaction(async (tx) => {
    const calls = await tx.call.findMany({
      where,
      include: CALL_INCLUDE,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.call.count({ where });
    return [calls, count] as const;
  });

  return { calls: rows.map((row) => toCallResponse(row, userId)), total };
}

/**
 * Close out calls left mid-flight by a previous process (crash / deploy) or by a client
 * that vanished without signalling.
 *
 * Without this, a restart would leave rows stuck in RINGING forever and the partial
 * unique index would block every future call in that conversation.
 *
 * The cut-offs are deliberately separate:
 *  - RINGING older than the ring timeout is MISSED (the timer is per process, so a
 *    deploy can lose it);
 *  - ACCEPTED older than the hard duration ceiling is ENDED (a crashed browser can never
 *    hold a session open forever).
 *
 * A temporary socket drop is NOT handled here: the socket layer waits
 * `CALL_DISCONNECT_GRACE_MS` first, so a tab switch or a quick reconnect keeps the call.
 */
export async function reconcileStaleCalls(now = new Date()): Promise<number> {
  const [ringing, accepted] = await Promise.all([
    prisma.call.updateMany({
      where: {
        status: 'RINGING',
        startedAt: { lt: new Date(now.getTime() - getRingTimeoutMs()) },
      },
      data: { status: 'MISSED', endedAt: now },
    }),
    prisma.call.updateMany({
      where: {
        status: 'ACCEPTED',
        startedAt: { lt: new Date(now.getTime() - getMaxCallDurationMs()) },
      },
      data: { status: 'ENDED', endedAt: now },
    }),
  ]);

  return ringing.count + accepted.count;
}
