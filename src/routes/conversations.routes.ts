import { Router } from 'express';
import { z } from 'zod';

import * as callController from '../controllers/call.controller.js';
import * as chatController from '../controllers/chat.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { chatRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { listCallsQuerySchema } from '../schemas/call.schema.js';
import { uuidSchema } from '../schemas/common.schema.js';
import {
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  sendMessageBodySchema,
  startConversationBodySchema,
} from '../schemas/chat.schema.js';

const router = Router();

router.use(authenticate);

const conversationIdParamSchema = z.object({ id: uuidSchema });
const bookingConversationParamSchema = z.object({ bookingId: uuidSchema });

/**
 * @openapi
 * /api/v1/conversations:
 *   get:
 *     tags: [Chat]
 *     summary: List my conversations
 *     description: >-
 *       Inbox ordered by most recent activity. Each entry carries the other
 *       participant, the last message and an unread count.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated conversations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Conversation' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Chat]
 *     summary: Start (or reuse) a private conversation
 *     description: >-
 *       Idempotent per pair of users. Blocked users cannot start a conversation (403).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [participantId]
 *             properties:
 *               participantId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Conversation
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Conversation' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/', validate({ query: listConversationsQuerySchema }), chatController.listConversations);
router.post('/', validate({ body: startConversationBodySchema }), chatController.startConversation);
/**
 * @openapi
 * /api/v1/conversations/booking/{bookingId}:
 *   post:
 *     tags: [Chat]
 *     summary: Open or create the conversation for an accepted booking
 *     description: >-
 *       The authenticated caller must be the booking client or its coach.
 *       Participants are derived from the booking and only one conversation can
 *       be created for each booking. Existing conversations remain accessible
 *       after completion, but not after rejection or cancellation.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: bookingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       201: { description: Shared booking conversation }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Booking is not accepted }
 */
router.post(
  '/booking/:bookingId',
  validate({ params: bookingConversationParamSchema }),
  chatController.openBookingConversation,
);

/**
 * @openapi
 * /api/v1/conversations/{id}/messages:
 *   get:
 *     tags: [Chat]
 *     summary: Get conversation history (members only)
 *     description: Returns messages oldest-first so a client can append directly.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Message' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Chat]
 *     summary: Send a message (members only)
 *     description: >-
 *       Persists the message and broadcasts it over Socket.IO to the conversation room.
 *       Blocked participants cannot message each other (403). Rate limited per account.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string, minLength: 1, maxLength: 4000 }
 *     responses:
 *       201:
 *         description: Message sent
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Message' } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get(
  '/:id/messages',
  validate({ params: conversationIdParamSchema, query: listMessagesQuerySchema }),
  chatController.listMessages,
);
router.post(
  '/:id/messages',
  chatRateLimiter,
  validate({ params: conversationIdParamSchema, body: sendMessageBodySchema }),
  chatController.sendMessage,
);

/**
 * @openapi
 * /api/v1/conversations/{id}/read:
 *   patch:
 *     tags: [Chat]
 *     summary: Mark a conversation as read (members only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Read receipt recorded }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/:id/read', validate({ params: conversationIdParamSchema }), chatController.markRead);

/**
 * @openapi
 * /api/v1/conversations/{id}/calls:
 *   get:
 *     tags: [Calls]
 *     summary: Get the call log for a conversation (members only)
 *     description: >-
 *       Returns past audio/video calls for this conversation, newest first, with the
 *       direction resolved for the authenticated user. Only call metadata is stored -
 *       never media, SDP or ICE candidates.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated call log
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Call' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/:id/calls',
  validate({ params: conversationIdParamSchema, query: listCallsQuerySchema }),
  callController.listConversationCalls,
);

export default router;
