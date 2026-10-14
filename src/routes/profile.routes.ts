import { Router } from 'express';
import { z } from 'zod';

import * as profileController from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { uuidSchema } from '../schemas/common.schema.js';
import {
  addProfileSportBodySchema,
  replaceProfileSportsBodySchema,
  updateProfileBodySchema,
} from '../schemas/profile.schema.js';

const router = Router();

const userIdParamSchema = z.object({ userId: uuidSchema });
const sportIdParamSchema = z.object({ sportId: uuidSchema });
const emptyQuerySchema = z.object({}).strict();

/**
 * @openapi
 * /api/v1/profile/me:
 *   get:
 *     tags: [Profile]
 *     summary: Get my profile
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: My profile including disciplines and coach-profile link
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/SelfProfile' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   patch:
 *     tags: [Profile]
 *     summary: Update my profile
 *     description: Partial update. Send `null` to clear a field; omit it to keep the current value.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ProfileInput' }
 *     responses:
 *       200:
 *         description: Updated profile
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/SelfProfile' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', authenticate, validate({ query: emptyQuerySchema }), profileController.getMyProfile);
router.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileBodySchema }),
  profileController.updateMyProfile,
);

/**
 * @openapi
 * /api/v1/profile/me/sports:
 *   get:
 *     tags: [Profile]
 *     summary: List my disciplines
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: My disciplines
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/ProfileSport' } } } }
 *   put:
 *     tags: [Profile]
 *     summary: Replace my disciplines (idempotent)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sportSlugs: { type: array, items: { type: string }, example: [boxing, fitness] }
 *               sportIds: { type: array, items: { type: string, format: uuid } }
 *               level: { type: string, enum: [BEGINNER, INTERMEDIATE, ADVANCED, PROFESSIONAL], nullable: true }
 *     responses:
 *       200: { description: Updated disciplines }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *   post:
 *     tags: [Profile]
 *     summary: Add one discipline
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sportId]
 *             properties:
 *               sportId: { type: string, format: uuid }
 *               level: { type: string, enum: [BEGINNER, INTERMEDIATE, ADVANCED, PROFESSIONAL], nullable: true }
 *     responses:
 *       201: { description: Discipline added }
 *       400: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/me/sports', authenticate, validate({ query: emptyQuerySchema }), profileController.listMySports);
router.put(
  '/me/sports',
  authenticate,
  validate({ body: replaceProfileSportsBodySchema }),
  profileController.replaceMySports,
);
router.post(
  '/me/sports',
  authenticate,
  validate({ body: addProfileSportBodySchema }),
  profileController.addMySport,
);

/**
 * @openapi
 * /api/v1/profile/me/sports/{sportId}:
 *   delete:
 *     tags: [Profile]
 *     summary: Remove one of my disciplines
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: sportId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Discipline removed }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete(
  '/me/sports/:sportId',
  authenticate,
  validate({ params: sportIdParamSchema }),
  profileController.removeMySport,
);

/**
 * @openapi
 * /api/v1/profile/{userId}:
 *   get:
 *     tags: [Profile]
 *     summary: Get a user's public profile
 *     description: >-
 *       Privacy-safe projection: never exposes email, phone, reports or other
 *       moderation data.
 *     parameters:
 *       - { in: path, name: userId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Public profile
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/PublicProfile' } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:userId', validate({ params: userIdParamSchema }), profileController.getProfile);

export default router;
