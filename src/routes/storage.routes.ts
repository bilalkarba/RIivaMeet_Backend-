import express, { Router } from 'express';

import { storageConfig } from '../config/storage.js';
import * as storageController from '../controllers/storage.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { createUploadBodySchema, localUploadQuerySchema } from '../schemas/storage.schema.js';

const router = Router();

/**
 * @openapi
 * /api/v1/storage/status:
 *   get:
 *     tags: [Storage]
 *     summary: Report whether object storage is configured
 *     description: >-
 *       Clients use this to render a real "media unavailable" state instead of a fake
 *       upload UI. `configured: false` means the media endpoints answer 503 and text-only
 *       features keep working.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Storage status
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/StorageStatus' }
 */
router.get('/status', authenticate, storageController.getStatus);

/**
 * @openapi
 * /api/v1/storage/uploads:
 *   post:
 *     tags: [Storage]
 *     summary: Create a presigned upload target
 *     description: >-
 *       Returns a presigned URL the client uploads the bytes to directly. The API never
 *       stores the bytes itself. Answers 503 with `details.requiredEnvVars` when object
 *       storage is not configured.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contentType]
 *             properties:
 *               kind: { type: string, enum: [avatar, post], default: avatar }
 *               contentType: { type: string, example: image/png }
 *     responses:
 *       201:
 *         description: Upload target created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UploadTarget' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       503: { $ref: '#/components/responses/ServiceUnavailable' }
 */
router.post('/uploads', authenticate, validate({ body: createUploadBodySchema }), storageController.createUpload);

/**
 * @openapi
 * /api/v1/storage/local:
 *   put:
 *     tags: [Storage]
 *     summary: Dev-only raw upload endpoint (local storage provider)
 *     description: >-
 *       Only reachable when STORAGE_PROVIDER=local in a non-production environment.
 *       Authenticated by the signed token issued with the upload URL.
 *     parameters:
 *       - { in: query, name: key, required: true, schema: { type: string } }
 *       - { in: query, name: exp, required: true, schema: { type: integer } }
 *       - { in: query, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Object stored }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.put(
  '/local',
  express.raw({
    type: () => true,
    limit: Math.max(storageConfig.maxUploadBytes, storageConfig.documentMaxUploadBytes),
  }),
  validate({ query: localUploadQuerySchema }),
  storageController.localUpload,
);

export default router;
