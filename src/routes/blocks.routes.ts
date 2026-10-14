import { Router } from 'express';
import { z } from 'zod';

import * as safetyController from '../controllers/safety.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { uuidSchema } from '../schemas/common.schema.js';
import { blockBodySchema } from '../schemas/safety.schema.js';

const router = Router();

const userIdParamSchema = z.object({ userId: uuidSchema });
const emptyQuerySchema = z.object({}).strict();

/**
 * @openapi
 * /api/v1/blocks:
 *   get:
 *     tags: [Safety]
 *     summary: List the users I have blocked
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Blocked users
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/BlockedUser' } } } }
 *   post:
 *     tags: [Safety]
 *     summary: Block a user
 *     description: >-
 *       Idempotent. Blocked users are removed from my discovery results and cannot
 *       message me. Blocking does not delete the other account.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The updated block list
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',
  authenticate,
  validate({ query: emptyQuerySchema }),
  safetyController.listBlocks,
);
router.post('/', authenticate, validate({ body: blockBodySchema }), safetyController.blockUser);

/**
 * @openapi
 * /api/v1/blocks/{userId}:
 *   delete:
 *     tags: [Safety]
 *     summary: Unblock a user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: userId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The updated block list
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/:userId', authenticate, validate({ params: userIdParamSchema }), safetyController.unblockUser);

export default router;
