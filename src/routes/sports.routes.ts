import { Router } from 'express';

import * as sportController from '../controllers/sport.controller.js';

const router = Router();

/**
 * @openapi
 * /api/v1/sports:
 *   get:
 *     tags: [Sports]
 *     summary: List all sports
 *     description: Public catalogue seeded with Fitness, Boxing, Swimming, Football and Tennis. `coachCount` counts published coach profiles only.
 *     responses:
 *       200:
 *         description: Sports list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Sport' }
 */
router.get('/', sportController.listSports);

export default router;
