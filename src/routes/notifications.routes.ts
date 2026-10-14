import { Router } from 'express';

import * as notificationController from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /api/v1/notifications/mine:
 *   get:
 *     tags: [Notifications]
 *     summary: Read my booking notifications
 *     description: Returns the latest 20 notifications for the authenticated user and the total unread count.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Notification inbox
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     unreadCount: { type: integer }
 *                     notifications: { type: array, items: { type: object } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/mine', notificationController.listMyNotifications);

/**
 * @openapi
 * /api/v1/notifications/mine/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark my notifications as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Number of notifications marked read
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/mine/read', notificationController.markMyNotificationsRead);

export default router;
