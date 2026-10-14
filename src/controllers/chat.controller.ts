import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import { getRealtime } from '../realtime/socket.js';
import type {
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageBody,
  StartConversationBody,
} from '../schemas/chat.schema.js';
import * as chatService from '../services/chat.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** POST /api/v1/conversations */
export async function startConversation(req: Request, res: Response): Promise<void> {
  const { participantId } = validatedBody<StartConversationBody>(req);
  const conversation = await chatService.startDirectConversation(requireUserId(req), participantId);
  sendCreated(res, conversation);
}

/** POST /api/v1/conversations/booking/:bookingId */
export async function openBookingConversation(req: Request, res: Response): Promise<void> {
  const { bookingId } = validatedParams<{ bookingId: string }>(req);
  const conversation = await chatService.openBookingConversation(requireUserId(req), bookingId);
  sendCreated(res, conversation);
}

/** GET /api/v1/conversations */
export async function listConversations(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListConversationsQuery>(req);
  const { conversations, total } = await chatService.listConversations(requireUserId(req), query);
  sendPaginated(res, conversations, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/conversations/:id/messages */
export async function listMessages(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const query = validatedQuery<ListMessagesQuery>(req);
  const { messages, total } = await chatService.listMessages(requireUserId(req), id, query);
  sendPaginated(res, messages, buildPaginationMeta(query.page, query.limit, total));
}

/**
 * POST /api/v1/conversations/:id/messages
 * Persists through the service, then fans the message out over Socket.IO (if running).
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { body } = validatedBody<SendMessageBody>(req);
  const message = await chatService.sendMessage(requireUserId(req), id, body);
  getRealtime()?.emitNewMessage(id, message);
  sendCreated(res, message);
}

/** PATCH /api/v1/conversations/:id/read */
export async function markRead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const result = await chatService.markConversationRead(requireUserId(req), id);
  sendData(res, result);
}
