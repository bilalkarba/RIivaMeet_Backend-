import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type { CreateBookingBody, ListBookingsQuery } from '../schemas/booking.schema.js';
import { getRealtime } from '../realtime/socket.js';
import * as bookingService from '../services/booking.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendData, sendPaginated } from '../utils/http.js';
import type { AuthenticatedUser } from '../utils/jwt.js';

function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user;
}

/** POST /api/v1/bookings - a client requests a session. */
export async function createBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = validatedBody<CreateBookingBody>(req);
  const created = await bookingService.createBooking(user.id, body);
  getRealtime()?.emitNewNotification(created.recipientUserId, created.notification);
  sendCreated(res, created.booking);
}

/** GET /api/v1/bookings/mine */
export async function listMyBookings(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const query = validatedQuery<ListBookingsQuery>(req);
  const { bookings, total } = await bookingService.listMyBookings(user, query);
  sendPaginated(res, bookings, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/bookings/:id */
export async function getBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const booking = await bookingService.getBookingById(user, id);
  sendData(res, booking);
}

/** PATCH /api/v1/bookings/:id/accept */
export async function acceptBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const booking = await bookingService.acceptBooking(user, id);
  sendData(res, booking);
}

/** PATCH /api/v1/bookings/:id/reject */
export async function rejectBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const booking = await bookingService.rejectBooking(user, id);
  sendData(res, booking);
}

/** PATCH /api/v1/bookings/:id/cancel */
export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const booking = await bookingService.cancelBooking(user, id);
  sendData(res, booking);
}

/** PATCH /api/v1/bookings/:id/complete */
export async function completeBooking(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const booking = await bookingService.completeBooking(user, id);
  sendData(res, booking);
}
