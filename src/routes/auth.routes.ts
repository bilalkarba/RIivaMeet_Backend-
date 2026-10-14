import { Router } from 'express';

import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { loginBodySchema, registerBodySchema } from '../schemas/auth.schema.js';

const router = Router();

/**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a CLIENT or COACH account
 *     description: >
 *       Creates an account and returns an access token. `role` may only be CLIENT or
 *       COACH - ADMIN accounts cannot be created through the public API. Emails are
 *       normalized (trimmed, lower-cased) and must be unique (409 on duplicates).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name]
 *             properties:
 *               email: { type: string, format: email, example: alex@example.com }
 *               password: { type: string, minLength: 8, maxLength: 72, example: Passw0rd123 }
 *               name: { type: string, minLength: 2, maxLength: 120, example: Alex Doe }
 *               phone: { type: string, example: "+4915112345678" }
 *               role: { type: string, enum: [CLIENT, COACH], default: CLIENT }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/register', authRateLimiter, validate({ body: registerBodySchema }), authController.register);

/**
 * @openapi
 * /api/v1/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in and receive a JWT access token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: alex@example.com }
 *               password: { type: string, example: Passw0rd123 }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/login', authRateLimiter, validate({ body: loginBodySchema }), authController.login);

/**
 * @openapi
 * /api/v1/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the signed-in user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     user: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', authenticate, authController.me);

export default router;
