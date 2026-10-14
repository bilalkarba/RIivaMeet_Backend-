import { Router } from 'express';

import { healthCheck } from '../controllers/health.controller.js';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness/readiness probe
 *     description: Returns 200 when the API can reach PostgreSQL, 503 otherwise. Not rate limited.
 *     responses:
 *       200:
 *         description: Service healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 service: { type: string, example: coachini-api }
 *                 version: { type: string, example: 1.0.0 }
 *                 uptimeSeconds: { type: number, example: 123.45 }
 *                 timestamp: { type: string, format: date-time }
 *                 checks:
 *                   type: object
 *                   properties:
 *                     database: { type: string, enum: [up, down] }
 *                     databaseLatencyMs: { type: integer, nullable: true, example: 3 }
 *       503:
 *         description: Database unreachable
 */
router.get('/', healthCheck);

export default router;
