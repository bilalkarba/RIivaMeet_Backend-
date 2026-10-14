import { prisma } from '../config/prisma.js';
import { BookingStatus } from '../generated/prisma/enums.js';
import type { CreateReviewBody, ListReviewsQuery } from '../schemas/booking.schema.js';
import { ApiError } from '../utils/errors.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';
import { toReviewResponse, type RatingSummary, type ReviewResponse } from '../utils/presenters.js';

/**
 * Review service.
 *
 * Rules enforced here (and, for duplicates, by a unique index on `reviews.booking_id`):
 *  - only the client who owns the booking may review it;
 *  - only COMPLETED bookings can be reviewed;
 *  - exactly one review per booking;
 *  - rating is an integer 1-5 and the comment is length-checked (Zod).
 */

export async function createReview(
  userId: string,
  bookingId: string,
  input: CreateReviewBody,
): Promise<ReviewResponse> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      clientId: true,
      coachProfileId: true,
      status: true,
      review: { select: { id: true } },
    },
  });

  if (!booking) {
    throw ApiError.notFound('Booking not found');
  }

  if (booking.clientId !== userId) {
    throw ApiError.forbidden('Only the client who made the booking can review it');
  }

  if (booking.status !== BookingStatus.COMPLETED) {
    throw ApiError.conflict(
      `Only completed bookings can be reviewed. This booking is ${booking.status}`,
      { currentStatus: booking.status, requiredStatus: BookingStatus.COMPLETED },
    );
  }

  if (booking.review) {
    throw ApiError.conflict('This booking has already been reviewed', { reviewId: booking.review.id });
  }

  try {
    const review = await prisma.review.create({
      data: {
        bookingId: booking.id,
        clientId: userId,
        coachProfileId: booking.coachProfileId,
        rating: input.rating,
        comment: input.comment ?? null,
      },
      include: { client: { select: { id: true, name: true } } },
    });

    return toReviewResponse(review);
  } catch (error) {
    // Lost the race against a concurrent review for the same booking.
    if (isUniqueConstraintViolation(error)) {
      throw ApiError.conflict('This booking has already been reviewed');
    }
    throw error;
  }
}

export async function getReviewForBooking(bookingId: string, userId: string): Promise<ReviewResponse | null> {
  const review = await prisma.review.findUnique({
    where: { bookingId },
    include: { client: { select: { id: true, name: true } } },
  });

  if (!review) {
    return null;
  }

  if (review.clientId !== userId) {
    throw ApiError.forbidden('You do not have access to this review');
  }

  return toReviewResponse(review);
}

export async function listCoachReviews(
  coachProfileId: string,
  query: ListReviewsQuery,
): Promise<{ reviews: ReviewResponse[]; total: number; summary: RatingSummary }> {
  const coach = await prisma.coachProfile.findFirst({
    where: { id: coachProfileId, isPublished: true },
    select: { id: true },
  });

  if (!coach) {
    throw ApiError.notFound('Coach profile not found');
  }

  const [reviews, total, aggregate] = await prisma.$transaction(async (tx) => {
    const rows = await tx.review.findMany({
      where: { coachProfileId },
      include: { client: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.review.count({ where: { coachProfileId } });
    const summary = await tx.review.aggregate({
      where: { coachProfileId },
      _avg: { rating: true },
      _count: { _all: true },
    });
    return [rows, count, summary] as const;
  });

  const reviewCount = aggregate._count._all;
  const average = aggregate._avg.rating;

  return {
    reviews: reviews.map(toReviewResponse),
    total,
    summary: {
      averageRating: reviewCount > 0 && average !== null ? Math.round(average * 100) / 100 : null,
      reviewCount,
    },
  };
}
