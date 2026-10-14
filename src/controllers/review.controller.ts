import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type { CreateReviewBody, ListReviewsQuery } from '../schemas/booking.schema.js';
import * as reviewService from '../services/review.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendPaginated } from '../utils/http.js';

/** POST /api/v1/bookings/:id/review */
export async function createReview(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized();
  }
  const { id } = validatedParams<{ id: string }>(req);
  const body = validatedBody<CreateReviewBody>(req);
  const review = await reviewService.createReview(user.id, id, body);
  sendCreated(res, review);
}

/** GET /api/v1/coaches/:id/reviews */
export async function listCoachReviews(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const query = validatedQuery<ListReviewsQuery>(req);
  const { reviews, total, summary } = await reviewService.listCoachReviews(id, query);

  sendPaginated(res, reviews, {
    ...buildPaginationMeta(query.page, query.limit, total),
    // The rating summary travels with the list so clients do not need a second call.
    // It is always derived from the reviews table, never stored.
    summary,
  });
}
