import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { BookingStatus, NotificationType, Role } from '../generated/prisma/enums.js';
import type { CreateBookingBody, ListBookingsQuery } from '../schemas/booking.schema.js';
import type { AuthenticatedUser } from '../utils/jwt.js';
import { ApiError } from '../utils/errors.js';
import {
  toBookingNotificationResponse,
  toBookingResponse,
  type BookingNotificationResponse,
  type BookingResponse,
} from '../utils/presenters.js';
import { isRecordNotFoundError } from '../utils/prisma-helpers.js';
import { runSerializableTransaction } from '../utils/transaction.js';

/**
 * Booking service.
 *
 * State machine (documented in the README and Swagger):
 *
 *   PENDING  --accept (coach)-->  ACCEPTED  --complete (coach)-->  COMPLETED
 *      |                              |
 *      +--reject (coach)--> REJECTED  +--cancel (client|coach)--> CANCELLED
 *      +--cancel (client|coach)--> CANCELLED
 *
 * Cancellation is allowed from PENDING and ACCEPTED only. REJECTED, CANCELLED and
 * COMPLETED are terminal.
 *
 * Overlap protection: two clients (or the same client twice) cannot hold accepted
 * bookings that intersect in time for the same coach. The check runs inside a
 * SERIALIZABLE transaction so concurrent requests cannot both pass it; PostgreSQL
 * aborts one of them and we retry (see `utils/transaction.ts`).
 */

const BOOKING_INCLUDE = {
  client: { select: { id: true, name: true } },
  coachProfile: {
    select: {
      id: true,
      userId: true,
      city: true,
      neighborhood: true,
      hourlyPrice: true,
      user: { select: { id: true, name: true } },
    },
  },
  review: { select: { id: true, rating: true, comment: true, createdAt: true } },
} as const satisfies Prisma.BookingInclude;

const CANCELLABLE_STATUSES: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.ACCEPTED];
const BLOCKING_CLIENT_STATUSES: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.ACCEPTED];

export interface CreatedBooking {
  booking: BookingResponse;
  notification: BookingNotificationResponse;
  recipientUserId: string;
}

export async function createBooking(clientId: string, input: CreateBookingBody): Promise<CreatedBooking> {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  if (startAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('startAt must be in the future', { startAt: input.startAt });
  }

  const coach = await prisma.coachProfile.findFirst({
    where: { id: input.coachProfileId, isPublished: true },
    select: { id: true, userId: true, hourlyPrice: true },
  });

  if (!coach) {
    throw ApiError.notFound('Coach profile not found or not published');
  }

  if (coach.userId === clientId) {
    throw ApiError.badRequest('You cannot book your own coach profile');
  }

  // The requested window must fit inside one of the coach's open availability slots.
  const coveringSlot = await prisma.availability.findFirst({
    where: {
      coachProfileId: coach.id,
      isAvailable: true,
      startAt: { lte: startAt },
      endAt: { gte: endAt },
    },
    select: { id: true },
  });

  if (!coveringSlot) {
    throw ApiError.conflict(
      'The requested time is outside the coach availability. Choose a slot covered by one of the coach availability windows.',
      { coachProfileId: coach.id, startAt: input.startAt, endAt: input.endAt },
    );
  }

  const durationHours = (endAt.getTime() - startAt.getTime()) / 3_600_000;
  const priceAtBooking = new Prisma.Decimal(coach.hourlyPrice)
    .mul(durationHours)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

  const created = await runSerializableTransaction(async (tx) => {
    await assertNoOverlap(tx, coach.id, clientId, startAt, endAt);

    const booking = await tx.booking.create({
      data: {
        clientId,
        coachProfileId: coach.id,
        startAt,
        endAt,
        priceAtBooking,
        status: BookingStatus.PENDING,
      },
      include: BOOKING_INCLUDE,
    });

    const notification = await tx.notification.create({
      data: {
        recipientId: coach.userId,
        bookingId: booking.id,
        type: NotificationType.BOOKING_REQUEST,
      },
      include: {
        booking: {
          select: {
            startAt: true,
            endAt: true,
            client: { select: { name: true } },
          },
        },
      },
    });

    return { booking, notification };
  });

  return {
    booking: toBookingResponse(created.booking),
    notification: toBookingNotificationResponse(created.notification),
    recipientUserId: coach.userId,
  };
}

export async function acceptBooking(user: AuthenticatedUser, bookingId: string): Promise<BookingResponse> {
  const booking = await loadBookingWithOwner(bookingId);
  assertIsOwningCoach(booking, user);

  if (booking.status !== BookingStatus.PENDING) {
    throw invalidTransition(booking.status, 'accept', [BookingStatus.PENDING]);
  }

  const updated = await runSerializableTransaction(async (tx) => {
    // Re-check inside the transaction: two accepts can race.
    await assertNoOverlap(tx, booking.coachProfileId, booking.clientId, booking.startAt, booking.endAt, booking.id);

    try {
      return await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.ACCEPTED },
        include: BOOKING_INCLUDE,
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw ApiError.notFound('Booking not found');
      }
      throw error;
    }
  });

  return toBookingResponse(updated);
}

export async function rejectBooking(user: AuthenticatedUser, bookingId: string): Promise<BookingResponse> {
  const booking = await loadBookingWithOwner(bookingId);
  assertIsOwningCoach(booking, user);

  if (booking.status !== BookingStatus.PENDING) {
    throw invalidTransition(booking.status, 'reject', [BookingStatus.PENDING]);
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.REJECTED },
    include: BOOKING_INCLUDE,
  });

  return toBookingResponse(updated);
}

export async function cancelBooking(user: AuthenticatedUser, bookingId: string): Promise<BookingResponse> {
  const booking = await loadBookingWithOwner(bookingId);

  const isClient = booking.clientId === user.id;
  const isCoach = booking.coachProfile.userId === user.id;
  const isAdmin = user.role === Role.ADMIN;

  if (!isClient && !isCoach && !isAdmin) {
    throw ApiError.forbidden('You can only cancel your own bookings');
  }

  if (!CANCELLABLE_STATUSES.includes(booking.status)) {
    throw invalidTransition(booking.status, 'cancel', CANCELLABLE_STATUSES);
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.CANCELLED },
    include: BOOKING_INCLUDE,
  });

  return toBookingResponse(updated);
}

export async function completeBooking(user: AuthenticatedUser, bookingId: string): Promise<BookingResponse> {
  const booking = await loadBookingWithOwner(bookingId);
  assertIsOwningCoach(booking, user);

  if (booking.status !== BookingStatus.ACCEPTED) {
    throw invalidTransition(booking.status, 'complete', [BookingStatus.ACCEPTED]);
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.COMPLETED },
    include: BOOKING_INCLUDE,
  });

  return toBookingResponse(updated);
}

export async function getBookingById(user: AuthenticatedUser, bookingId: string): Promise<BookingResponse> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });

  if (!booking) {
    throw ApiError.notFound('Booking not found');
  }

  const isClient = booking.clientId === user.id;
  const isCoach = booking.coachProfile.userId === user.id;
  const isAdmin = user.role === Role.ADMIN;

  if (!isClient && !isCoach && !isAdmin) {
    throw ApiError.forbidden('You do not have access to this booking');
  }

  return toBookingResponse(booking);
}

/**
 * Bookings for the signed-in user.
 * - CLIENT: bookings they requested.
 * - COACH:  bookings requested against their own coach profile.
 * - ADMIN:  every booking.
 */
export async function listMyBookings(
  user: AuthenticatedUser,
  query: ListBookingsQuery,
): Promise<{ bookings: BookingResponse[]; total: number }> {
  let scope: Prisma.BookingWhereInput;

  if (user.role === Role.ADMIN) {
    scope = {};
  } else if (user.role === Role.COACH) {
    const profile = await prisma.coachProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
    // A coach without a profile simply has no bookings yet.
    scope = profile ? { coachProfileId: profile.id } : { id: { equals: '00000000-0000-0000-0000-000000000000' } };
  } else {
    scope = { clientId: user.id };
  }

  const where: Prisma.BookingWhereInput = {
    ...scope,
    ...(query.status ? { status: query.status } : {}),
  };

  // A callback transaction keeps the page and its total consistent. The reads are
  // awaited sequentially on purpose: they share one connection, and Prisma's array
  // form of `$transaction` dispatches them concurrently on that connection.
  const [bookings, total] = await prisma.$transaction(async (tx) => {
    const rows = await tx.booking.findMany({
      where,
      include: BOOKING_INCLUDE,
      orderBy: { startAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.booking.count({ where });
    return [rows, count] as const;
  });

  return { bookings: bookings.map(toBookingResponse), total };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BookingWithOwner {
  id: string;
  clientId: string;
  coachProfileId: string;
  startAt: Date;
  endAt: Date;
  status: BookingStatus;
  coachProfile: { id: string; userId: string };
}

async function loadBookingWithOwner(bookingId: string): Promise<BookingWithOwner> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      clientId: true,
      coachProfileId: true,
      startAt: true,
      endAt: true,
      status: true,
      coachProfile: { select: { id: true, userId: true } },
    },
  });

  if (!booking) {
    throw ApiError.notFound('Booking not found');
  }

  return booking;
}

function assertIsOwningCoach(booking: BookingWithOwner, user: AuthenticatedUser): void {
  if (booking.coachProfile.userId !== user.id) {
    throw ApiError.forbidden('Only the coach who owns this booking can perform this action');
  }
}

/**
 * Rejects the change when it would create overlapping ACCEPTED bookings for the
 * same coach, or a second active request from the same client for the same window.
 * Must run inside the serializable transaction passed in as `tx`.
 */
async function assertNoOverlap(
  tx: Prisma.TransactionClient,
  coachProfileId: string,
  clientId: string,
  startAt: Date,
  endAt: Date,
  excludeBookingId?: string,
): Promise<void> {
  const coachConflict = await tx.booking.findFirst({
    where: {
      coachProfileId,
      status: BookingStatus.ACCEPTED,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: { id: true, startAt: true, endAt: true },
  });

  if (coachConflict) {
    throw ApiError.conflict('The coach already has an accepted booking that overlaps this time slot', {
      conflictingBookingId: coachConflict.id,
      conflictingStartAt: coachConflict.startAt.toISOString(),
      conflictingEndAt: coachConflict.endAt.toISOString(),
    });
  }

  const clientConflict = await tx.booking.findFirst({
    where: {
      clientId,
      status: { in: BLOCKING_CLIENT_STATUSES },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: { id: true, startAt: true, endAt: true },
  });

  if (clientConflict) {
    throw ApiError.conflict('You already have a pending or accepted booking that overlaps this time slot', {
      conflictingBookingId: clientConflict.id,
    });
  }
}

function invalidTransition(current: BookingStatus, action: string, allowed: BookingStatus[]): ApiError {
  return ApiError.conflict(
    `Cannot ${action} a booking with status ${current}. Allowed from: ${allowed.join(', ')}`,
    { currentStatus: current, allowedFrom: allowed },
  );
}
