import { Router } from 'express';

import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import blockRoutes from './blocks.routes.js';
import bookingRoutes from './bookings.routes.js';
import callRoutes from './calls.routes.js';
import coachRoutes from './coaches.routes.js';
import conversationRoutes from './conversations.routes.js';
import matchRoutes from './matches.routes.js';
import notificationRoutes from './notifications.routes.js';
import profileRoutes from './profile.routes.js';
import reportRoutes from './reports.routes.js';
import sportRoutes from './sports.routes.js';
import storageRoutes from './storage.routes.js';

/**
 * API v1 router. Everything here is mounted under `/api/v1` in `app.ts`.
 * New resources (payments, chat, media) are added as sibling routers so the
 * architecture stays open without touching existing modules.
 */
const router = Router();

router.use('/auth', authRoutes);
router.use('/sports', sportRoutes);
router.use('/profile', profileRoutes);
router.use('/coaches', coachRoutes);
router.use('/bookings', bookingRoutes);
router.use('/calls', callRoutes);
router.use('/matches', matchRoutes);
router.use('/notifications', notificationRoutes);
router.use('/storage', storageRoutes);
router.use('/blocks', blockRoutes);
router.use('/reports', reportRoutes);
router.use('/conversations', conversationRoutes);
router.use('/admin', adminRoutes);

export default router;
