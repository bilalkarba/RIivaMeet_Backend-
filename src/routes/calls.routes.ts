import { Router } from 'express';

import * as callController from '../controllers/call.controller.js';
import { authenticate } from '../middleware/authenticate.js';

/**
 * Audio / video call signalling is carried over Socket.IO (see `src/realtime/socket.ts`);
 * this router only exposes the ICE configuration the browser needs to negotiate a peer
 * connection. TURN credentials are minted per request and never stored client-side.
 */
const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /api/v1/calls/config:
 *   get:
 *     tags: [Calls]
 *     summary: ICE servers for a WebRTC peer connection
 *     description: >-
 *       Returns the STUN/TURN servers to pass to `RTCPeerConnection`, plus the ring
 *       timeout the UI should honour. TURN credentials are short-lived and minted
 *       server-side, so no long-lived TURN secret is ever exposed to the browser.
 *       Calls are peer-to-peer and are never recorded.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: ICE configuration
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/CallConfig' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/config', callController.getCallConfig);

export default router;
