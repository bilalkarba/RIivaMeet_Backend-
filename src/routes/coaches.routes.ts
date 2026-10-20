import { Router } from 'express';
import { z } from 'zod';

import * as coachController from '../controllers/coach.controller.js';
import * as reviewController from '../controllers/review.controller.js';
import * as verificationController from '../controllers/verification.controller.js';
import { Role } from '../generated/prisma/enums.js';
import { authenticate, optionalAuthenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { listReviewsQuerySchema } from '../schemas/booking.schema.js';
import {
  createAvailabilityBodySchema,
  createCoachProfileBodySchema,
  replaceCoachSportsBodySchema,
  searchCoachesQuerySchema,
  updateCoachProfileBodySchema,
} from '../schemas/coach.schema.js';
import { uuidParamSchema, uuidSchema } from '../schemas/common.schema.js';
import {
  startDocumentUploadBodySchema,
  verificationDocumentParamSchema,
} from '../schemas/verification.schema.js';

const router = Router();

const sportIdParamSchema = z.object({ sportId: uuidSchema });
const availabilityIdParamSchema = z.object({ availabilityId: uuidSchema });

/**
 * @openapi
 * /api/v1/coaches:
 *   get:
 *     tags: [Coaches]
 *     summary: Search published coach profiles
 *     description: >
 *       Returns only published profiles (isPublished = true) and combines every filter
 *       with AND. When `latitude` + `longitude` are supplied, each result carries
 *       `distanceKm` (Haversine, computed in PostgreSQL - no PostGIS required) and
 *       `radiusKm` restricts the result set. Without coordinates, search by
 *       `city`/`neighborhood`. `averageRating`/`reviewCount` are always derived from
 *       the reviews table.
 *     parameters:
 *       - { in: query, name: sport, schema: { type: string }, description: Sport slug or name, example: boxing }
 *       - { in: query, name: city, schema: { type: string }, description: Case-insensitive exact match }
 *       - { in: query, name: neighborhood, schema: { type: string }, description: Case-insensitive exact match }
 *       - { in: query, name: minPrice, schema: { type: number, minimum: 0 }, description: Minimum hourly price }
 *       - { in: query, name: maxPrice, schema: { type: number, minimum: 0 }, description: Maximum hourly price }
 *       - { in: query, name: minRating, schema: { type: number, minimum: 1, maximum: 5 }, description: Minimum average rating }
 *       - { in: query, name: latitude, schema: { type: number, minimum: -90, maximum: 90 }, description: Required together with longitude }
 *       - { in: query, name: longitude, schema: { type: number, minimum: -180, maximum: 180 } }
 *       - { in: query, name: radiusKm, schema: { type: number, maximum: 20000 }, description: Requires latitude + longitude }
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [newest, oldest, price_asc, price_desc, rating_desc, rating_asc, distance_asc, distance_desc]
 *           default: newest
 *         description: distance_* requires latitude + longitude
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated coach list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Coach' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 */
// `optionalAuthenticate` lets signed-in callers have blocked accounts filtered out
// while keeping the endpoint public for anonymous search.
router.get(
  '/',
  optionalAuthenticate,
  validate({ query: searchCoachesQuerySchema }),
  coachController.searchCoaches,
);

/**
 * @openapi
 * /api/v1/coaches/me/profile:
 *   get:
 *     tags: [Coaches]
 *     summary: Get my coach profile (COACH only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: My profile including unpublished state and availability
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/CoachDetail' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Coaches]
 *     summary: Create my coach profile (COACH only)
 *     description: >
 *       Creates the profile for the authenticated coach. New profiles start unpublished:
 *       add at least one sport, provide coordinates, then publish via PATCH.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CoachProfileInput' }
 *     responses:
 *       201:
 *         description: Profile created
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/CoachDetail' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *   patch:
 *     tags: [Coaches]
 *     summary: Update my coach profile (COACH only)
 *     description: >
 *       Partial update. Setting `isPublished: true` requires latitude/longitude and at
 *       least one offered sport.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CoachProfileInput' }
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/CoachDetail' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/me/profile', authenticate, authorize(Role.COACH), coachController.getMyProfile);
router.post(
  '/me/profile',
  authenticate,
  authorize(Role.COACH),
  validate({ body: createCoachProfileBodySchema }),
  coachController.createMyProfile,
);
router.patch(
  '/me/profile',
  authenticate,
  authorize(Role.COACH),
  validate({ body: updateCoachProfileBodySchema }),
  coachController.updateMyProfile,
);

/**
 * @openapi
 * /api/v1/coaches/me/sports:
 *   get:
 *     tags: [Coaches]
 *     summary: List the sports I teach (COACH only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Sports list
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Sport' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   put:
 *     tags: [Coaches]
 *     summary: Replace the sports I teach (COACH only)
 *     description: Idempotent. Provide `sportSlugs` (from GET /api/v1/sports) or `sportIds`.
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
 *     responses:
 *       200:
 *         description: Updated sports list
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Coaches]
 *     summary: Add one sport to my profile (COACH only)
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
 *     responses:
 *       201:
 *         description: Sport added
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/me/sports',
  authenticate,
  authorize(Role.COACH),
  validate({ query: z.object({}).strict() }),
  coachController.listMySports,
);
router.put(
  '/me/sports',
  authenticate,
  authorize(Role.COACH),
  validate({ body: replaceCoachSportsBodySchema }),
  coachController.replaceMySports,
);
router.post(
  '/me/sports',
  authenticate,
  authorize(Role.COACH),
  validate({ body: z.object({ sportId: uuidSchema }).strict() }),
  coachController.addMySport,
);

/**
 * @openapi
 * /api/v1/coaches/me/sports/{sportId}:
 *   delete:
 *     tags: [Coaches]
 *     summary: Remove a sport from my profile (COACH only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: sportId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Sport removed
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete(
  '/me/sports/:sportId',
  authenticate,
  authorize(Role.COACH),
  validate({ params: sportIdParamSchema }),
  coachController.removeMySport,
);

/**
 * @openapi
 * /api/v1/coaches/me/availability:
 *   get:
 *     tags: [Availability]
 *     summary: List my availability windows (COACH only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Availability windows
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Availability' } } } }
 *   post:
 *     tags: [Availability]
 *     summary: Add an availability window (COACH only)
 *     description: >
 *       Windows must be chronologically valid and must not overlap an existing window.
 *       A booking can only be requested when its full time range fits inside one
 *       `isAvailable: true` window.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [startAt, endAt]
 *             properties:
 *               startAt: { type: string, format: date-time, example: '2026-06-01T09:00:00.000Z' }
 *               endAt: { type: string, format: date-time, example: '2026-06-01T12:00:00.000Z' }
 *               isAvailable: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Window created
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.get(
  '/me/availability',
  authenticate,
  authorize(Role.COACH),
  validate({ query: z.object({}).strict() }),
  coachController.listMyAvailability,
);
router.post(
  '/me/availability',
  authenticate,
  authorize(Role.COACH),
  validate({ body: createAvailabilityBodySchema }),
  coachController.createMyAvailability,
);

/**
 * @openapi
 * /api/v1/coaches/me/availability/{availabilityId}:
 *   delete:
 *     tags: [Availability]
 *     summary: Delete one of my availability windows (COACH only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: availabilityId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Window deleted
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete(
  '/me/availability/:availabilityId',
  authenticate,
  authorize(Role.COACH),
  validate({ params: availabilityIdParamSchema }),
  coachController.deleteMyAvailability,
);

// ---------------------------------------------------------------------------
// Coach verification (COACH only)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/coaches/me/verification:
 *   get:
 *     tags: [Verification]
 *     summary: My verification application (COACH only)
 *     description: >-
 *       Returns the coach's own application: official status, uploaded documents, the
 *       advisory machine analysis and the administrator's feedback. `status` is
 *       `NOT_SUBMITTED` until the first document upload.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Verification application
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CoachVerification' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/me/verification', authenticate, authorize(Role.COACH), verificationController.getMyVerification);

/**
 * @openapi
 * /api/v1/coaches/me/verification/status:
 *   get:
 *     tags: [Verification]
 *     summary: My verification/public-visibility status (COACH only)
 *     description: >-
 *       `isPubliclyVisible` is true only when the application is APPROVED *and* the
 *       profile satisfies the publication rules (coordinates + at least one sport).
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Status }
 */
router.get('/me/verification/status', authenticate, authorize(Role.COACH), verificationController.getMyStatus);

/**
 * @openapi
 * /api/v1/coaches/me/verification/documents:
 *   post:
 *     tags: [Verification]
 *     summary: Request a private upload target for a document (COACH only)
 *     description: >-
 *       Returns a presigned URL plus a `documentId`. The storage key is generated by the
 *       server. After uploading the bytes the client must call the confirm endpoint; only
 *       confirmed documents are reviewed. Answers 503 when object storage is unconfigured.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, contentType]
 *             properties:
 *               type: { type: string, enum: [DIPLOMA, CERTIFICATION, OTHER] }
 *               contentType: { type: string, enum: [application/pdf, image/jpeg, image/png] }
 *               fileName: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: Upload target created }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       503: { $ref: '#/components/responses/ServiceUnavailable' }
 */
router.post(
  '/me/verification/documents',
  authenticate,
  authorize(Role.COACH),
  validate({ body: startDocumentUploadBodySchema }),
  verificationController.startDocumentUpload,
);

/**
 * @openapi
 * /api/v1/coaches/me/verification/documents/{documentId}/confirm:
 *   post:
 *     tags: [Verification]
 *     summary: Confirm an uploaded document (COACH only)
 *     description: >-
 *       Verifies the object exists in storage, is within the size limit and really is the
 *       declared file type (file-signature check), then makes the document current.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: documentId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Document confirmed }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post(
  '/me/verification/documents/:documentId/confirm',
  authenticate,
  authorize(Role.COACH),
  validate({ params: verificationDocumentParamSchema }),
  verificationController.confirmDocumentUpload,
);

/**
 * @openapi
 * /api/v1/coaches/me/verification/documents/{documentId}:
 *   delete:
 *     tags: [Verification]
 *     summary: Remove one of my documents (COACH only)
 *     description: Allowed only while the application is editable (DRAFT, NEEDS_INFO, REJECTED).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: documentId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Document removed }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.delete(
  '/me/verification/documents/:documentId',
  authenticate,
  authorize(Role.COACH),
  validate({ params: verificationDocumentParamSchema }),
  verificationController.removeDocument,
);

/**
 * @openapi
 * /api/v1/coaches/me/verification/submit:
 *   post:
 *     tags: [Verification]
 *     summary: Submit (or resubmit) my verification application (COACH only)
 *     description: >-
 *       Requires the configured documents. Moves the application to PENDING and starts the
 *       advisory machine analysis in the background; only an administrator can approve it.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Application submitted }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post('/me/verification/submit', authenticate, authorize(Role.COACH), verificationController.submitVerification);

/**
 * @openapi
 * /api/v1/coaches/{id}:
 *   get:
 *     tags: [Coaches]
 *     summary: Get one published coach profile
 *     description: "The `id` is the CoachProfile id. Only APPROVED, published profiles are visible; anything else returns 404."
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Coach profile with upcoming availability
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/CoachDetail' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate({ params: uuidParamSchema }), coachController.getCoach);

/**
 * @openapi
 * /api/v1/coaches/{id}/reviews:
 *   get:
 *     tags: [Reviews]
 *     summary: List reviews for a coach
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid }, description: CoachProfile id }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated reviews with a derived rating summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Review' } }
 *                 meta:
 *                   allOf:
 *                     - $ref: '#/components/schemas/PaginationMeta'
 *                     - type: object
 *                       properties:
 *                         summary:
 *                           type: object
 *                           properties:
 *                             averageRating: { type: number, nullable: true, example: 4.5 }
 *                             reviewCount: { type: integer, example: 12 }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get(
  '/:id/reviews',
  validate({ params: uuidParamSchema, query: listReviewsQuerySchema }),
  reviewController.listCoachReviews,
);

export default router;
