import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  ListConversationsQuery,
  ListMessagesQuery,
} from '../schemas/chat.schema.js';
import { ApiError } from '../utils/errors.js';
import {
  toConversationResponse,
  toMessageResponse,
  type ConversationResponse,
  type MessageResponse,
} from '../utils/presenters.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';
import { isBlockedBetween } from './block.service.js';

/**
 * Private 1:1 chat service (Phase 3).
 *
 * Every read and write re-checks conversation membership and the block relation, so a
 * leaked conversation id is useless to a third party and a block takes effect
 * immediately in both directions - no exception for "already open" conversations.
 *
 * Realtime delivery is layered on top by `src/realtime/socket.ts`, which calls
 * `sendMessage` and then fans the result out to the participants' rooms. The service
 * itself stays transport-agnostic (same rules for REST and sockets).
 */

const PARTICIPANT_SELECT = {
  userId: true,
  user: { select: { id: true, name: true, displayName: true, avatarUrl: true } },
} as const;

export async function ensureMembership(userId: string, conversationId: string): Promise<void> {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      userId: true,
      conversation: { select: { booking: { select: { status: true } } } },
    },
  });

  // 403 (not 404) so a non-member cannot probe which conversation ids exist.
  if (!participant) {
    throw ApiError.forbidden('You are not a participant in this conversation');
  }

  const status = participant.conversation.booking?.status;
  if (status && status !== 'ACCEPTED' && status !== 'COMPLETED') {
    throw ApiError.conflict('Messaging is unavailable for this booking', { currentStatus: status });
  }
}

async function requireOtherParticipant(conversationId: string, userId: string): Promise<string> {
  const other = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: userId } },
    select: { userId: true },
  });

  if (!other) {
    throw ApiError.notFound('Conversation has no other participant');
  }
  return other.userId;
}

/** Start (or reuse) the private conversation between the caller and `otherUserId`. */
export async function startDirectConversation(
  userId: string,
  otherUserId: string,
): Promise<ConversationResponse> {
  if (userId === otherUserId) {
    throw ApiError.badRequest('You cannot start a conversation with yourself');
  }

  const target = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } });
  if (!target) {
    throw ApiError.notFound('User not found');
  }

  if (await isBlockedBetween(userId, otherUserId)) {
    throw ApiError.forbidden('You cannot start a conversation with this user');
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: otherUserId } } },
      ],
    },
    include: { participants: { select: PARTICIPANT_SELECT } },
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    return toConversationResponse(existing, userId);
  }

  const created = await prisma.conversation.create({
    data: { participants: { create: [{ userId }, { userId: otherUserId }] } },
    include: { participants: { select: PARTICIPANT_SELECT } },
  });

  return toConversationResponse(created, userId);
}

/** Open or create the one private conversation associated with an accepted booking. */
export async function openBookingConversation(
  userId: string,
  bookingId: string,
): Promise<ConversationResponse> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      clientId: true,
      status: true,
      coachProfile: { select: { userId: true } },
    },
  });

  if (!booking) {
    throw ApiError.notFound('Booking not found');
  }

  const coachUserId = booking.coachProfile.userId;
  if (userId !== booking.clientId && userId !== coachUserId) {
    throw ApiError.forbidden('You can only open a conversation for your own booking');
  }

  if (booking.status !== 'ACCEPTED' && booking.status !== 'COMPLETED') {
    throw ApiError.conflict('Conversation is available only for accepted bookings', {
      currentStatus: booking.status,
    });
  }

  if (await isBlockedBetween(booking.clientId, coachUserId)) {
    throw ApiError.forbidden('You cannot start a conversation with this user');
  }

  const include = { participants: { select: PARTICIPANT_SELECT } } as const;
  const existing = await prisma.conversation.findUnique({ where: { bookingId }, include });
  if (existing) {
    return toConversationResponse(existing, userId);
  }

  try {
    const created = await prisma.conversation.create({
      data: {
        bookingId,
        participants: { create: [{ userId: booking.clientId }, { userId: coachUserId }] },
      },
      include,
    });
    return toConversationResponse(created, userId);
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    const concurrent = await prisma.conversation.findUnique({ where: { bookingId }, include });
    if (!concurrent) {
      throw error;
    }
    return toConversationResponse(concurrent, userId);
  }
}

export async function listConversations(
  userId: string,
  query: ListConversationsQuery,
): Promise<{ conversations: ConversationResponse[]; total: number }> {
  const where = { participants: { some: { userId } } };

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const conversations = await tx.conversation.findMany({
      where,
      include: { participants: { select: PARTICIPANT_SELECT } },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.conversation.count({ where });
    return [conversations, count] as const;
  });

  const ids = rows.map((row) => row.id);
  const [lastMessages, unreadByConversation] = await Promise.all([
    loadLastMessages(ids),
    loadUnreadCounts(userId, ids),
  ]);

  const conversations = rows.map((row) =>
    toConversationResponse(row, userId, {
      lastMessage: lastMessages.get(row.id) ?? null,
      unreadCount: unreadByConversation.get(row.id) ?? 0,
    }),
  );

  return { conversations, total };
}

export async function listMessages(
  userId: string,
  conversationId: string,
  query: ListMessagesQuery,
): Promise<{ messages: MessageResponse[]; total: number }> {
  await ensureMembership(userId, conversationId);

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const messages = await tx.message.findMany({
      where: { conversationId },
      // `id` is a deterministic tiebreaker for messages that share a millisecond, so
      // paging never drifts between requests.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.message.count({ where: { conversationId } });
    return [messages, count] as const;
  });

  // Return oldest-to-newest so the client can append directly.
  return { messages: rows.reverse().map(toMessageResponse), total };
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  body: string,
): Promise<MessageResponse> {
  await ensureMembership(userId, conversationId);

  const otherUserId = await requireOtherParticipant(conversationId, userId);
  if (await isBlockedBetween(userId, otherUserId)) {
    throw ApiError.forbidden('You cannot message this user');
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: userId, body },
    });
    // Bump the conversation so inboxes sort by recency without a message join.
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: created.createdAt } });
    return created;
  });

  return toMessageResponse(message);
}

export async function markConversationRead(
  userId: string,
  conversationId: string,
): Promise<{ conversationId: string; lastReadAt: string }> {
  await ensureMembership(userId, conversationId);
  const now = new Date();

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: now },
  });

  return { conversationId, lastReadAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadLastMessages(
  conversationIds: string[],
): Promise<Map<string, { id: string; conversationId: string; senderId: string; body: string; createdAt: Date }>> {
  const map = new Map<string, { id: string; conversationId: string; senderId: string; body: string; createdAt: Date }>();
  if (conversationIds.length === 0) {
    return map;
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['conversationId'],
  });

  for (const row of rows) {
    map.set(row.conversationId, row);
  }
  return map;
}

/** One grouped query returns the unread count per conversation for the viewer. */
async function loadUnreadCounts(userId: string, conversationIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (conversationIds.length === 0) {
    return map;
  }

  const rows = await prisma.$queryRaw<{ conversation_id: string; unread: number }[]>(Prisma.sql`
    SELECT m.conversation_id AS conversation_id, COUNT(*)::int AS unread
    FROM messages m
    JOIN conversation_participants p
      ON p.conversation_id = m.conversation_id AND p.user_id = ${userId}
    WHERE m.conversation_id IN (${Prisma.join(conversationIds)})
      AND m.sender_id <> ${userId}
      AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
    GROUP BY m.conversation_id
  `);

  for (const row of rows) {
    map.set(row.conversation_id, row.unread);
  }
  return map;
}
