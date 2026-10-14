import { Router } from 'express';

import * as adminController from '../controllers/admin.controller.js';
import { Role } from '../generated/prisma/enums.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { uuidParamSchema } from '../schemas/common.schema.js';
import { adminListReportsQuerySchema, resolveReportBodySchema } from '../schemas/safety.schema.js';

const router = Router();

// The whole back-office is ADMIN-only; role checks happen before any handler runs.
router.use(authenticate, authorize(Role.ADMIN));

/**
 * @openapi
 * /api/v1/admin/reports:
 *   get:
 *     tags: [Admin]
 *     summary: Moderation queue (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, RESOLVED, REJECTED], default: PENDING }
 *       - in: query
 *         name: targetType
 *         schema: { type: string, enum: [USER, POST, MESSAGE] }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated reports including reporter and target
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/AdminReport' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/reports', validate({ query: adminListReportsQuerySchema }), adminController.listReports);

/**
 * @openapi
 * /api/v1/admin/reports/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one report (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Report detail
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/AdminReport' } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/reports/:id', validate({ params: uuidParamSchema }), adminController.getReport);

/**
 * @openapi
 * /api/v1/admin/reports/{id}/resolve:
 *   patch:
 *     tags: [Admin]
 *     summary: Resolve a report (ADMIN only)
 *     description: PENDING -> RESOLVED. Records the reviewer and timestamp. 409 if already decided.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, minLength: 3, maxLength: 2000 }
 *     responses:
 *       200: { description: Report resolved }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/reports/:id/resolve',
  validate({ params: uuidParamSchema, body: resolveReportBodySchema }),
  adminController.resolveReport,
);

/**
 * @openapi
 * /api/v1/admin/reports/{id}/reject:
 *   patch:
 *     tags: [Admin]
 *     summary: Reject a report (ADMIN only)
 *     description: PENDING -> REJECTED. 409 if already decided.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Report rejected }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/reports/:id/reject',
  validate({ params: uuidParamSchema, body: resolveReportBodySchema }),
  adminController.rejectReport,
);

export default router;
