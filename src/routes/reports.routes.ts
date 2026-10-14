import { Router } from 'express';

import * as safetyController from '../controllers/safety.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { uuidParamSchema } from '../schemas/common.schema.js';
import { createReportBodySchema, listMyReportsQuerySchema } from '../schemas/safety.schema.js';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /api/v1/reports:
 *   post:
 *     tags: [Safety]
 *     summary: Report a user, post or message
 *     description: >-
 *       Only USER targets are accepted today; POST/MESSAGE targets return 400 until the
 *       community feed and chat exist. A second pending report for the same target
 *       returns 409. Reports are only visible to the reporter and to admins.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetType, targetId, reason]
 *             properties:
 *               targetType: { type: string, enum: [USER, POST, MESSAGE] }
 *               targetId: { type: string, format: uuid, description: User id for USER reports }
 *               reason: { type: string, enum: [SPAM, HARASSMENT, INAPPROPRIATE_CONTENT, FAKE_PROFILE, OTHER] }
 *               description: { type: string, minLength: 3, maxLength: 2000 }
 *     responses:
 *       201:
 *         description: Report recorded
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Report' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post('/', validate({ body: createReportBodySchema }), safetyController.createReport);

/**
 * @openapi
 * /api/v1/reports/mine:
 *   get:
 *     tags: [Safety]
 *     summary: List the reports I filed
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, RESOLVED, REJECTED] }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: My reports
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Report' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 */
router.get('/mine', validate({ query: listMyReportsQuerySchema }), safetyController.listMyReports);

/**
 * @openapi
 * /api/v1/reports/{id}:
 *   get:
 *     tags: [Safety]
 *     summary: Get one of my reports
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Report
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Report' } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate({ params: uuidParamSchema }), safetyController.getMyReport);

export default router;
