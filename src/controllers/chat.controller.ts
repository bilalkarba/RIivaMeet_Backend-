import type { NextFunction, Request, Response } from "express";

import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from "../middleware/validate.js";
import { getRealtime } from "../realtime/socket.js";
import type {
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageBody,
  StartConversationBody,
  UpdateMessageBody,
  UploadAttachmentBody,
} from "../schemas/chat.schema.js";
import * as chatService from "../services/chat.service.js";
import {
  CHAT_ATTACHMENT_CONTENT_TYPES,
} from "../services/storage.service.js";
import { isStorageAvailable, resolveStorageConfig, storageConfig } from "../config/storage.js";
import { env } from "../config/env.js";
import {
  getModerationPolicy,
  isModerationEnabled,
} from "../services/moderation.service.js";
import { ApiError } from "../utils/errors.js";
import {
  buildPaginationMeta,
  sendCreated,
  sendData,
  sendPaginated,
} from "../utils/http.js";

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** POST /api/v1/conversations */
export async function startConversation(
  req: Request,
  res: Response,
): Promise<void> {
  const { participantId } = validatedBody<StartConversationBody>(req);
  const conversation = await chatService.startDirectConversation(
    requireUserId(req),
    participantId,
  );
  sendCreated(res, conversation);
}

/** POST /api/v1/conversations/booking/:bookingId */
export async function openBookingConversation(
  req: Request,
  res: Response,
): Promise<void> {
  const { bookingId } = validatedParams<{ bookingId: string }>(req);
  const conversation = await chatService.openBookingConversation(
    requireUserId(req),
    bookingId,
  );
  sendCreated(res, conversation);
}

/** GET /api/v1/conversations */
export async function listConversations(
  req: Request,
  res: Response,
): Promise<void> {
  const query = validatedQuery<ListConversationsQuery>(req);
  const { conversations, total } = await chatService.listConversations(
    requireUserId(req),
    query,
  );
  sendPaginated(
    res,
    conversations,
    buildPaginationMeta(query.page, query.limit, total),
  );
}

/** GET /api/v1/conversations/:id/messages */
export async function listMessages(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const query = validatedQuery<ListMessagesQuery>(req);
  const { messages, total } = await chatService.listMessages(
    requireUserId(req),
    id,
    query,
  );
  sendPaginated(
    res,
    messages,
    buildPaginationMeta(query.page, query.limit, total),
  );
}

/**
 * POST /api/v1/conversations/:id/messages
 * Persists through the service, then fans the message out over Socket.IO (if running).
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { body } = validatedBody<SendMessageBody>(req);
  const { message, moderation } = await chatService.sendMessage(
    requireUserId(req),
    id,
    body,
  );
  // The moderation outcome is returned to the sender only; the broadcast stays a plain
  // message so recipients never receive detector details.
  getRealtime()?.emitNewMessage(id, message);
  sendCreated(res, { ...message, moderation });
}

/** POST /api/v1/conversations/:id/attachments */
export async function sendAttachment(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { body, clientUploadId } = validatedBody<UploadAttachmentBody>(req);
  if (!req.file) {
    throw ApiError.badRequest("An attachment file is required");
  }
  const { message, moderation, duplicate } =
    await chatService.sendAttachmentMessage(
      requireUserId(req),
      id,
      body,
      clientUploadId,
      req.file,
    );
  // A retried upload (same clientUploadId) points at the already-broadcast row; emitting
  // again would duplicate the message in every participant's realtime feed.
  if (!duplicate) {
    getRealtime()?.emitNewMessage(id, message);
  }
  sendCreated(res, {
    ...message,
    moderation,
    ...(duplicate ? { duplicate: true } : {}),
  });
}

/** GET /api/v1/conversations/:id/messages/:messageId/attachment */
export async function downloadAttachment(req: Request, res: Response): Promise<void> {
  const { id, messageId } = validatedParams<{ id: string; messageId: string }>(req);
  const attachment = await chatService.getMessageAttachment(
    requireUserId(req),
    id,
    messageId,
  );
  const filename = attachment.fileName.replace(/["\\\r\n]/g, "_");
  res
    .status(200)
    .set({
      "Content-Type": attachment.contentType,
      "Content-Disposition": `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      "Content-Length": String(attachment.body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .send(attachment.body);
}

export function attachmentConfig(_req: Request, res: Response): void {
  sendData(res, {
    configured:
      isStorageAvailable(resolveStorageConfig()) &&
      (storageConfig.provider !== "s3" || Boolean(env.STORAGE_DOCUMENT_BUCKET)),
    maxBytes: storageConfig.maxUploadBytes,
    contentTypes: CHAT_ATTACHMENT_CONTENT_TYPES,
  });
}

/** Confirm membership before multipart bytes are accepted into memory. */
export async function assertAttachmentMembership(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  await chatService.ensureMembership(requireUserId(req), id);
  next();
}

/** PATCH /api/v1/conversations/:id/messages/:messageId */
export async function updateMessage(
  req: Request,
  res: Response,
): Promise<void> {
  const { id, messageId } = validatedParams<{ id: string; messageId: string }>(
    req,
  );
  const { body, revision } = validatedBody<UpdateMessageBody>(req);
  const { message, moderation } = await chatService.updateMessage(
    requireUserId(req),
    id,
    messageId,
    body,
    revision,
  );
  getRealtime()?.emitUpdatedMessage(id, message);
  sendData(res, { ...message, moderation });
}

/** DELETE /api/v1/conversations/:id/messages/:messageId */
export async function deleteMessage(
  req: Request,
  res: Response,
): Promise<void> {
  const { id, messageId } = validatedParams<{ id: string; messageId: string }>(
    req,
  );
  const deleted = await chatService.deleteMessage(
    requireUserId(req),
    id,
    messageId,
  );
  getRealtime()?.emitDeletedMessage(id, deleted);
  sendData(res, deleted);
}

/**
 * GET /api/v1/conversations/moderation-policy
 *
 * Lets the client mirror the server policy in its pre-send check (block vs. warn/flag).
 * The value is public configuration, not a secret; enforcement always happens server-side.
 */
export function moderationPolicy(_req: Request, res: Response): void {
  sendData(res, {
    enabled: isModerationEnabled(),
    policy: getModerationPolicy(),
  });
}

/** PATCH /api/v1/conversations/:id/read */
export async function markRead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const result = await chatService.markConversationRead(requireUserId(req), id);
  sendData(res, result);
}
