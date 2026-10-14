import { Router } from 'express';

import * as matchController from '../controllers/match.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { suggestionsQuerySchema } from '../schemas/profile.schema.js';

const router = Router();

/**
 * @openapi
 * /api/v1/matches/suggestions:
 *   get:
 *     tags: [Matching]
 *     summary: Compatible coach suggestions for the signed-in user
 *     description: >-
 *       Personalised discovery list. Coaches are ranked by discipline overlap, then
 *       location (city/country) and level. Blocked accounts never appear. Provide
 *       `latitude`/`longitude` to add `distanceKm` and filter by `radiusKm`.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: sport, schema: { type: string }, description: Sport slug or name }
 *       - { in: query, name: level, schema: { type: string, enum: [BEGINNER, INTERMEDIATE, ADVANCED, PROFESSIONAL] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: country, schema: { type: string } }
 *       - { in: query, name: latitude, schema: { type: number } }
 *       - { in: query, name: longitude, schema: { type: number } }
 *       - { in: query, name: radiusKm, schema: { type: number } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Ranked list of compatible coaches
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Coach' } }
 *                 meta:
 *                   allOf:
 *                     - $ref: '#/components/schemas/PaginationMeta'
 *                     - type: object
 *                       properties:
 *                         basis:
 *                           type: object
 *                           description: The viewer attributes used for ranking
 *                           properties:
 *                             sports: { type: array, items: { type: string } }
 *                             level: { type: string, nullable: true }
 *                             city: { type: string, nullable: true }
 *                             country: { type: string, nullable: true }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get(
  '/suggestions',
  authenticate,
  validate({ query: suggestionsQuerySchema }),
  matchController.listSuggestions,
);

export default router;
