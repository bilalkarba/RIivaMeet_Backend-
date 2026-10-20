import { Router } from 'express';

import * as adminController from '../controllers/admin.controller.js';
import * as moderationController from '../controllers/moderation.controller.js';
import * as verificationController from '../controllers/verification.controller.js';
import { Role } from '../generated/prisma/enums.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { uuidParamSchema } from '../schemas/common.schema.js';
import {
  adminListModerationFlagsQuerySchema,
  reviewModerationFlagBodySchema,
} from '../schemas/moderation.schema.js';
import { adminListReportsQuerySchema, resolveReportBodySchema } from '../schemas/safety.schema.js';
import {
  adminDecisionBodySchema,
  adminListVerificationsQuerySchema,
  adminRejectBodySchema,
  adminRequestInfoBodySchema,
  grandfatherApprovalBodySchema,
  listUnverifiedCoachesQuerySchema,
  verificationDocumentParamSchema,
} from '../schemas/verification.schema.js';

const router = Router();

// The whole back-office is ADMIN-only; role checks happen before any handler runs.
router.use(authenticate, authorize(Role.ADMIN));

// ---------------------------------------------------------------------------
// Coach verification queue
//
// Every route below is ADMIN-only (enforced by the `router.use` above). Official decisions
// are made explicitly by an administrator.
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/admin/verifications:
 *   get:
 *     tags: [Admin]
 *     summary: Coach verification queue (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [DRAFT, PENDING, IN_REVIEW, NEEDS_INFO, APPROVED, REJECTED] } }
 *       - { in: query, name: coachProfileId, schema: { type: string, format: uuid } }
 *       - { in: query, name: submittedFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: submittedTo, schema: { type: string, format: date-time } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200: { description: Paginated applications }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/verifications', validate({ query: adminListVerificationsQuerySchema }), verificationController.listVerifications);

/**
 * @openapi
 * /api/v1/admin/verifications/unverified-coaches:
 *   get:
 *     tags: [Admin]
 *     summary: Published coaches that are not verified (ADMIN only)
 *     description: >-
 *       The deliberate rollout queue: coaches created before verification existed are not
 *       auto-approved and are not publicly discoverable until an administrator reviews
 *       them (see the grandfather endpoint).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200: { description: Paginated coaches awaiting verification }
 */
router.get(
  '/verifications/unverified-coaches',
  validate({ query: listUnverifiedCoachesQuerySchema }),
  verificationController.listUnverifiedCoaches,
);

/**
 * @openapi
 * /api/v1/admin/verifications/documents/{documentId}/file:
 *   get:
 *     tags: [Admin]
 *     summary: Stream a private verification document (ADMIN only)
 *     description: >-
 *       The bytes are proxied by the API with `Cache-Control: no-store`; documents are never
 *       served from a public object URL.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: documentId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Document bytes }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get(
  '/verifications/documents/:documentId/file',
  validate({ params: verificationDocumentParamSchema }),
  verificationController.downloadDocument,
);

/**
 * @openapi
 * /api/v1/admin/verifications/grandfather:
 *   post:
 *     tags: [Admin]
 *     summary: Record a manual (grandfathered) approval for an existing coach (ADMIN only)
 *     description: >-
 *       Creates or updates the coach's application to APPROVED with an auditable note. This
 *       is the only way an existing coach without documents can be verified, and it is always
 *       an explicit administrator action - nothing is approved automatically.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [coachProfileId, note]
 *             properties:
 *               coachProfileId: { type: string, format: uuid }
 *               note: { type: string, minLength: 3, maxLength: 2000 }
 *     responses:
 *       200: { description: Coach approved }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post(
  '/verifications/grandfather',
  validate({ body: grandfatherApprovalBodySchema }),
  verificationController.grandfather,
);

/**
 * @openapi
 * /api/v1/admin/verifications/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: One verification application with documents and history (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Application detail }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/verifications/:id', validate({ params: uuidParamSchema }), verificationController.getVerification);

/**
 * @openapi
 * /api/v1/admin/verifications/{id}/in-review:
 *   patch:
 *     tags: [Admin]
 *     summary: Mark an application as in review (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Marked as in review }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/verifications/:id/in-review',
  validate({ params: uuidParamSchema }),
  verificationController.markInReview,
);

/**
 * @openapi
 * /api/v1/admin/verifications/{id}/approve:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve a verification (ADMIN only)
 *     description: >-
 *       PENDING/IN_REVIEW -> APPROVED. Approval does not publish the profile: the existing
 *       publication rules (coordinates + at least one sport) still apply.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties: { note: { type: string, minLength: 3, maxLength: 2000 } }
 *     responses:
 *       200: { description: Approved }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/verifications/:id/approve',
  validate({ params: uuidParamSchema, body: adminDecisionBodySchema }),
  verificationController.approve,
);

/**
 * @openapi
 * /api/v1/admin/verifications/{id}/reject:
 *   patch:
 *     tags: [Admin]
 *     summary: Reject a verification (ADMIN only)
 *     description: PENDING/IN_REVIEW/NEEDS_INFO -> REJECTED. A reason is required.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [note]
 *             properties: { note: { type: string, minLength: 3, maxLength: 2000 } }
 *     responses:
 *       200: { description: Rejected }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/verifications/:id/reject',
  validate({ params: uuidParamSchema, body: adminRejectBodySchema }),
  verificationController.reject,
);

/**
 * @openapi
 * /api/v1/admin/verifications/{id}/request-info:
 *   patch:
 *     tags: [Admin]
 *     summary: Request more information from the coach (ADMIN only)
 *     description: PENDING/IN_REVIEW -> NEEDS_INFO. The coach can then replace documents and resubmit.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [note]
 *             properties: { note: { type: string, minLength: 3, maxLength: 2000 } }
 *     responses:
 *       200: { description: Additional information requested }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/verifications/:id/request-info',
  validate({ params: uuidParamSchema, body: adminRequestInfoBodySchema }),
  verificationController.requestInfo,
);

/**
 * @openapi
 * /api/v1/admin/message-flags:
 *   get:
 *     tags: [Admin]
 *     summary: Messages flagged for containing off-platform contact details (ADMIN only)
 *     description: >-
 *       Only populated when `MESSAGE_MODERATION_POLICY=flag`. The message itself was
 *       delivered; this queue shows detector kinds (never the matched phone number or
 *       address) plus the message body for a human decision.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: reviewed, schema: { type: string, enum: [true, false] } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200: { description: Paginated moderation flags }
 */
router.get(
  '/message-flags',
  validate({ query: adminListModerationFlagsQuerySchema }),
  moderationController.listFlags,
);

/**
 * @openapi
 * /api/v1/admin/message-flags/{id}/review:
 *   patch:
 *     tags: [Admin]
 *     summary: Mark a moderation flag as reviewed (ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties: { note: { type: string, minLength: 3, maxLength: 2000 } }
 *     responses:
 *       200: { description: Reviewed flag }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/message-flags/:id/review',
  validate({ params: uuidParamSchema, body: reviewModerationFlagBodySchema }),
  moderationController.reviewFlag,
);

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
