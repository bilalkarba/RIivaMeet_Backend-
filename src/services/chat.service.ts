import { createHash } from "node:crypto";
import path from "node:path";

import { prisma } from "../config/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type {
  ListConversationsQuery,
  ListMessagesQuery,
} from "../schemas/chat.schema.js";
import { ApiError } from "../utils/errors.js";
import type { ModerationOutcome } from "../types/moderation.js";
import {
  toConversationResponse,
  toMessageResponse,
  type ConversationResponse,
  type MessageResponse,
} from "../utils/presenters.js";
import { isUniqueConstraintViolation } from "../utils/prisma-helpers.js";
import { isBlockedBetween } from "./block.service.js";
import {
  assertMessageNotBlocked,
  moderateMessageText,
} from "./moderation.service.js";
import {
  deletePrivateObject,
  readPrivateObject,
  storeChatAttachment,
} from "./storage.service.js";

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
  user: {
    select: { id: true, name: true, displayName: true, avatarUrl: true },
  },
} as const;

export async function ensureMembership(
  userId: string,
  conversationId: string,
): Promise<void> {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      userId: true,
      conversation: { select: { booking: { select: { status: true } } } },
    },
  });

  // 403 (not 404) so a non-member cannot probe which conversation ids exist.
  if (!participant) {
    throw ApiError.forbidden("You are not a participant in this conversation");
  }

  const status = participant.conversation.booking?.status;
  if (status && status !== "ACCEPTED" && status !== "COMPLETED") {
    throw ApiError.conflict("Messaging is unavailable for this booking", {
      currentStatus: status,
    });
  }
}

async function requireOtherParticipant(
  conversationId: string,
  userId: string,
): Promise<string> {
  const other = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: userId } },
    select: { userId: true },
  });

  if (!other) {
    throw ApiError.notFound("Conversation has no other participant");
  }
  return other.userId;
}

/** Start (or reuse) the private conversation between the caller and `otherUserId`. */
export async function startDirectConversation(
  userId: string,
  otherUserId: string,
): Promise<ConversationResponse> {
  if (userId === otherUserId) {
    throw ApiError.badRequest("You cannot start a conversation with yourself");
  }

  const target = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { id: true },
  });
  if (!target) {
    throw ApiError.notFound("User not found");
  }

  if (await isBlockedBetween(userId, otherUserId)) {
    throw ApiError.forbidden("You cannot start a conversation with this user");
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: otherUserId } } },
      ],
    },
    include: { participants: { select: PARTICIPANT_SELECT } },
    orderBy: { createdAt: "asc" },
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
    throw ApiError.notFound("Booking not found");
  }

  const coachUserId = booking.coachProfile.userId;
  if (userId !== booking.clientId && userId !== coachUserId) {
    throw ApiError.forbidden(
      "You can only open a conversation for your own booking",
    );
  }

  if (booking.status !== "ACCEPTED" && booking.status !== "COMPLETED") {
    throw ApiError.conflict(
      "Conversation is available only for accepted bookings",
      {
        currentStatus: booking.status,
      },
    );
  }

  if (await isBlockedBetween(booking.clientId, coachUserId)) {
    throw ApiError.forbidden("You cannot start a conversation with this user");
  }

  const include = { participants: { select: PARTICIPANT_SELECT } } as const;
  const existing = await prisma.conversation.findUnique({
    where: { bookingId },
    include,
  });
  if (existing) {
    return toConversationResponse(existing, userId);
  }

  try {
    const created = await prisma.conversation.create({
      data: {
        bookingId,
        participants: {
          create: [{ userId: booking.clientId }, { userId: coachUserId }],
        },
      },
      include,
    });
    return toConversationResponse(created, userId);
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    const concurrent = await prisma.conversation.findUnique({
      where: { bookingId },
      include,
    });
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
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { attachment: true },
    });
    const count = await tx.message.count({ where: { conversationId } });
    return [messages, count] as const;
  });

  // Return oldest-to-newest so the client can append directly.
  return {
    messages: rows
      .reverse()
      .map((row) => toMessageResponse(row, row.attachment)),
    total,
  };
}

export interface SendMessageResult {
  message: MessageResponse;
  /** `ALLOW` for ordinary text; `WARN`/`FLAG` when contact details were detected. */
  moderation: ModerationOutcome;
  /**
   * True when an attachment retry reused the message persisted by an earlier attempt.
   * The transport must not broadcast it again (REST and Socket.IO would otherwise both
   * fan out the same row).
   */
  duplicate?: boolean;
}

export type UpdateMessageResult = SendMessageResult;

export interface DeleteMessageResult {
  messageId: string;
  conversationId: string;
}

export interface ChatAttachmentFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export interface PrivateAttachment {
  body: Buffer;
  fileName: string;
  contentType: string;
}

const CHAT_ATTACHMENT_TYPES: Record<string, { contentType: string; extensions: string[] }> = {
  "image/jpeg": { contentType: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  "image/png": { contentType: "image/png", extensions: [".png"] },
  "image/webp": { contentType: "image/webp", extensions: [".webp"] },
  "application/pdf": { contentType: "application/pdf", extensions: [".pdf"] },
};

function detectAttachmentContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

function validateChatAttachment(file: ChatAttachmentFile): {
  fileName: string;
  contentType: string;
  checksum: string;
} {
  const fileName = path.basename(file.originalname.replace(/[\\/]/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200);
  const declared = CHAT_ATTACHMENT_TYPES[file.mimetype];
  const actualContentType = detectAttachmentContentType(file.buffer);
  const extension = path.extname(fileName).toLowerCase();

  if (
    !declared ||
    actualContentType !== file.mimetype ||
    !declared.extensions.includes(extension) ||
    file.buffer.length === 0
  ) {
    throw ApiError.badRequest(
      "The attachment extension, MIME type, or file contents are invalid",
      { allowedContentTypes: Object.keys(CHAT_ATTACHMENT_TYPES) },
    );
  }

  return {
    fileName: fileName || "attachment",
    contentType: actualContentType,
    checksum: createHash("sha256").update(file.buffer).digest("hex"),
  };
}

/**
 * Persist and return one message.
 *
 * Moderation runs here, before the insert, so both REST and Socket.IO enforce exactly the
 * same policy. `block` throws before the row exists; `warn`/`flag` persist and return the
 * outcome to the sender. Flagged messages also create a review row in the same
 * transaction, so a flag can never refer to a message that was not stored.
 */
export async function sendMessage(
  userId: string,
  conversationId: string,
  body: string,
): Promise<SendMessageResult> {
  await ensureMembership(userId, conversationId);

  const otherUserId = await requireOtherParticipant(conversationId, userId);
  if (await isBlockedBetween(userId, otherUserId)) {
    throw ApiError.forbidden("You cannot message this user");
  }

  const moderation = moderateMessageText(body);
  assertMessageNotBlocked(moderation);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: userId, body },
    });
    // Bump the conversation so inboxes sort by recency without a message join.
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: created.createdAt },
    });

    if (moderation.action === "FLAG") {
      await tx.messageModerationFlag.create({
        data: {
          messageId: created.id,
          conversationId,
          senderId: userId,
          policy: moderation.policy,
          matches: moderation.matches as never,
        },
      });
    }

    return created;
  });

  return { message: toMessageResponse(message), moderation };
}

/** Store and persist one private attachment message, with retry-safe client upload IDs. */
export async function sendAttachmentMessage(
  userId: string,
  conversationId: string,
  body: string,
  clientUploadId: string,
  file: ChatAttachmentFile,
): Promise<SendMessageResult> {
  await ensureMembership(userId, conversationId);
  const otherUserId = await requireOtherParticipant(conversationId, userId);
  if (await isBlockedBetween(userId, otherUserId)) {
    throw ApiError.forbidden("You cannot message this user");
  }

  const moderation = moderateMessageText(body);
  assertMessageNotBlocked(moderation);
  const validatedFile = validateChatAttachment(file);
  const priorUpload = await findPriorAttachmentUpload(clientUploadId);
  if (priorUpload) {
    return resolveAttachmentRetry(
      priorUpload,
      userId,
      conversationId,
      body,
      file,
      validatedFile,
      moderation,
    );
  }

  const storageKey = await storeChatAttachment({
    conversationId,
    contentType: validatedFile.contentType,
    body: file.buffer,
  });

  try {
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          body,
          attachment: {
            create: {
              clientUploadId,
              storageKey,
              fileName: validatedFile.fileName,
              contentType: validatedFile.contentType,
              sizeBytes: file.buffer.byteLength,
              checksum: validatedFile.checksum,
            },
          },
        },
        include: { attachment: true },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      if (moderation.action === "FLAG") {
        await tx.messageModerationFlag.create({
          data: {
            messageId: created.id,
            conversationId,
            senderId: userId,
            policy: moderation.policy,
            matches: moderation.matches as never,
          },
        });
      }
      return created;
    });

    return {
      message: toMessageResponse(message, message.attachment),
      moderation,
    };
  } catch (error) {
    await deletePrivateObject(storageKey);
    if (isUniqueConstraintViolation(error)) {
      const retry = await findPriorAttachmentUpload(clientUploadId);
      if (retry) {
        return resolveAttachmentRetry(
          retry,
          userId,
          conversationId,
          body,
          file,
          validatedFile,
          moderation,
        );
      }
    }
    throw error;
  }
}

async function findPriorAttachmentUpload(clientUploadId: string) {
  return prisma.chatAttachment.findUnique({
    where: { clientUploadId },
    include: { message: { include: { attachment: true } } },
  });
}

async function resolveAttachmentRetry(
  attachment: NonNullable<Awaited<ReturnType<typeof findPriorAttachmentUpload>>>,
  userId: string,
  conversationId: string,
  body: string,
  file: ChatAttachmentFile,
  validatedFile: ReturnType<typeof validateChatAttachment>,
  moderation: ModerationOutcome,
): Promise<SendMessageResult> {
  if (
    attachment.message.senderId !== userId ||
    attachment.message.conversationId !== conversationId
  ) {
    throw ApiError.conflict("This upload identifier has already been used");
  }
  if (
    attachment.message.body !== body ||
    attachment.checksum !== validatedFile.checksum ||
    attachment.fileName !== validatedFile.fileName ||
    attachment.contentType !== validatedFile.contentType ||
    attachment.sizeBytes !== file.buffer.byteLength
  ) {
    throw ApiError.conflict("This upload identifier belongs to a different message");
  }
  return {
    message: toMessageResponse(attachment.message, attachment),
    moderation,
    duplicate: true,
  };
}

/** Read attachment bytes only after checking current conversation membership. */
export async function getMessageAttachment(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<PrivateAttachment> {
  await ensureMembership(userId, conversationId);
  const attachment = await prisma.chatAttachment.findFirst({
    where: { messageId, message: { conversationId } },
    select: { storageKey: true, fileName: true, contentType: true },
  });
  if (!attachment) {
    throw ApiError.notFound("Attachment not found");
  }
  return {
    body: await readPrivateObject(attachment.storageKey),
    fileName: attachment.fileName,
    contentType: attachment.contentType,
  };
}

/** Edit only the caller's message within a conversation they participate in. */
export async function updateMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  body: string,
  expectedRevision: number,
): Promise<UpdateMessageResult> {
  await ensureMembership(userId, conversationId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.message.findFirst({
      where: { id: messageId, conversationId },
      select: { senderId: true, revision: true },
    });

    if (!existing) {
      throw ApiError.notFound("Message not found");
    }
    if (existing.senderId !== userId) {
      throw ApiError.forbidden("You can only edit your own messages");
    }
    if (existing.revision !== expectedRevision) {
      throw ApiError.conflict(
        "This message changed while you were editing it. Please reload and try again.",
      );
    }

    const moderation = moderateMessageText(body);
    assertMessageNotBlocked(moderation);

    const updated = await tx.message.updateMany({
      where: {
        id: messageId,
        conversationId,
        senderId: userId,
        revision: expectedRevision,
      },
      data: { body, editedAt: new Date(), revision: { increment: 1 } },
    });

    if (updated.count !== 1) {
      throw ApiError.conflict(
        "This message changed while you were editing it. Please reload and try again.",
      );
    }

    if (moderation.action === "FLAG") {
      await tx.messageModerationFlag.create({
        data: {
          messageId,
          conversationId,
          senderId: userId,
          policy: moderation.policy,
          matches: moderation.matches as never,
        },
      });
    }

    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { attachment: true },
    });
    return {
      message: toMessageResponse(message, message.attachment),
      moderation,
    };
  });
}

/** Hard-delete only the caller's message and repair the conversation's latest-message time. */
export async function deleteMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<DeleteMessageResult> {
  await ensureMembership(userId, conversationId);

  const result = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.message.findFirst({
        where: { id: messageId, conversationId },
        select: {
          senderId: true,
          attachment: { select: { storageKey: true } },
        },
      });

      if (!existing) {
        throw ApiError.notFound("Message not found");
      }
      if (existing.senderId !== userId) {
        throw ApiError.forbidden("You can only delete your own messages");
      }

      const deleted = await tx.message.deleteMany({
        where: { id: messageId, conversationId, senderId: userId },
      });
      if (deleted.count !== 1) {
        throw ApiError.conflict("This message was already deleted");
      }

      const latestMessage = await tx.message.findFirst({
        where: { conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: latestMessage?.createdAt ?? null },
      });

      return {
        messageId,
        conversationId,
        storageKey: existing.attachment?.storageKey ?? null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (result.storageKey) {
    await deletePrivateObject(result.storageKey);
  }
  return { messageId, conversationId };
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
): Promise<
  Map<
    string,
    {
      id: string;
      conversationId: string;
      senderId: string;
      body: string;
      createdAt: Date;
      editedAt: Date | null;
      revision: number;
      attachment: {
        fileName: string;
        contentType: string;
        sizeBytes: number;
      } | null;
    }
  >
> {
  const map = new Map<
    string,
    {
      id: string;
      conversationId: string;
      senderId: string;
      body: string;
      createdAt: Date;
      editedAt: Date | null;
      revision: number;
      attachment: {
        fileName: string;
        contentType: string;
        sizeBytes: number;
      } | null;
    }
  >();
  if (conversationIds.length === 0) {
    return map;
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    distinct: ["conversationId"],
    include: { attachment: true },
  });

  for (const row of rows) {
    map.set(row.conversationId, {
      ...row,
      attachment: row.attachment
        ? {
            fileName: row.attachment.fileName,
            contentType: row.attachment.contentType,
            sizeBytes: row.attachment.sizeBytes,
          }
        : null,
    });
  }
  return map;
}

/** One grouped query returns the unread count per conversation for the viewer. */
async function loadUnreadCounts(
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (conversationIds.length === 0) {
    return map;
  }

  const rows = await prisma.$queryRaw<
    { conversation_id: string; unread: number }[]
  >(Prisma.sql`
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
