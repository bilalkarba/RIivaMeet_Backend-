import { Router } from 'express';

import * as bookingController from '../controllers/booking.controller.js';
import * as reviewController from '../controllers/review.controller.js';
import { Role } from '../generated/prisma/enums.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { createBookingBodySchema, createReviewBodySchema, listBookingsQuerySchema } from '../schemas/booking.schema.js';
import { uuidParamSchema } from '../schemas/common.schema.js';

const router = Router();

// Every booking route requires authentication.
router.use(authenticate);

/**
 * @openapi
 * /api/v1/bookings:
 *   post:
 *     tags: [Bookings]
 *     summary: Request a booking (CLIENT only)
 *     description: >
 *       Creates a PENDING booking request. The client is the authenticated user, so
 *       `clientId` is never read from the request body. Validations: the coach profile
 *       must be published, `startAt` must be in the future, the whole window must fit
 *       inside one of the coach's open availability windows, and neither the coach nor
 *       the client may already hold a conflicting booking. `priceAtBooking` snapshots
 *       the coach's hourly price at request time.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [coachProfileId, startAt, endAt]
 *             properties:
 *               coachProfileId: { type: string, format: uuid }
 *               startAt: { type: string, format: date-time, example: '2026-06-01T09:00:00.000Z' }
 *               endAt: { type: string, format: date-time, example: '2026-06-01T10:00:00.000Z' }
 *     responses:
 *       201:
 *         description: Booking request created
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Booking' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post('/', authorize(Role.CLIENT), validate({ body: createBookingBodySchema }), bookingController.createBooking);

/**
 * @openapi
 * /api/v1/bookings/mine:
 *   get:
 *     tags: [Bookings]
 *     summary: List my bookings
 *     description: CLIENT returns bookings they requested; COACH returns bookings on their own profile; ADMIN returns all bookings.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, ACCEPTED, REJECTED, CANCELLED, COMPLETED] }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Paginated bookings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Booking' } }
 *                 meta: { $ref: '#/components/schemas/PaginationMeta' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/mine', validate({ query: listBookingsQuerySchema }), bookingController.listMyBookings);

/**
 * @openapi
 * /api/v1/bookings/{id}:
 *   get:
 *     tags: [Bookings]
 *     summary: Get one booking
 *     description: Visible to the booking's client, the coach who owns it, and admins (403 otherwise).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Booking
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Booking' } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate({ params: uuidParamSchema }), bookingController.getBooking);

/**
 * @openapi
 * /api/v1/bookings/{id}/accept:
 *   patch:
 *     tags: [Bookings]
 *     summary: Accept a booking request (owning COACH only)
 *     description: PENDING -> ACCEPTED. Fails with 409 if it would overlap an already accepted booking for the same coach.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Booking accepted
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Booking' } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/:id/accept',
  authorize(Role.COACH),
  validate({ params: uuidParamSchema }),
  bookingController.acceptBooking,
);

/**
 * @openapi
 * /api/v1/bookings/{id}/reject:
 *   patch:
 *     tags: [Bookings]
 *     summary: Reject a booking request (owning COACH only)
 *     description: PENDING -> REJECTED. Terminal.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Booking rejected
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/:id/reject',
  authorize(Role.COACH),
  validate({ params: uuidParamSchema }),
  bookingController.rejectBooking,
);

/**
 * @openapi
 * /api/v1/bookings/{id}/cancel:
 *   patch:
 *     tags: [Bookings]
 *     summary: Cancel a booking
 *     description: >
 *       Allowed for the client who made the booking and for the coach who owns it,
 *       only while the booking is PENDING or ACCEPTED. REJECTED, CANCELLED and
 *       COMPLETED are terminal and return 409.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Booking cancelled
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch('/:id/cancel', validate({ params: uuidParamSchema }), bookingController.cancelBooking);

/**
 * @openapi
 * /api/v1/bookings/{id}/complete:
 *   patch:
 *     tags: [Bookings]
 *     summary: Mark an accepted booking completed (owning COACH only)
 *     description: ACCEPTED -> COMPLETED. Only completed bookings can be reviewed.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Booking completed
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.patch(
  '/:id/complete',
  authorize(Role.COACH),
  validate({ params: uuidParamSchema }),
  bookingController.completeBooking,
);

/**
 * @openapi
 * /api/v1/bookings/{id}/review:
 *   post:
 *     tags: [Reviews]
 *     summary: Review a completed booking (owning CLIENT only)
 *     description: >
 *       One review per booking, enforced by a unique index on reviews.booking_id.
 *       Rating must be an integer 1-5; comment is optional (3-1000 characters).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid }, description: Booking id }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5, example: 5 }
 *               comment: { type: string, minLength: 3, maxLength: 1000, example: Great session, very motivating! }
 *     responses:
 *       201:
 *         description: Review created
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { $ref: '#/components/schemas/Review' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post(
  '/:id/review',
  authorize(Role.CLIENT),
  validate({ params: uuidParamSchema, body: createReviewBodySchema }),
  reviewController.createReview,
);

export default router;
