import { z } from 'zod';

import { limitQuery, pageQuery, trimmedString, uuidSchema } from './common.schema.js';

/** Start (or reuse) a private conversation with another user. */
export const startConversationBodySchema = z.object({ participantId: uuidSchema }).strict();

/** Message text: non-empty, capped at 4000 characters (mirrored by a CHECK constraint). */
export const sendMessageBodySchema = z.object({ body: trimmedString(1, 4000) }).strict();

export const listConversationsQuerySchema = z
  .object({ page: pageQuery, limit: limitQuery })
  .strict();

export const listMessagesQuerySchema = z.object({ page: pageQuery, limit: limitQuery }).strict();

export type StartConversationBody = z.infer<typeof startConversationBodySchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
