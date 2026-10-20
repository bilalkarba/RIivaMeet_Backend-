import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type {
  AdminListModerationFlagsQuery,
  ReviewModerationFlagBody,
} from '../schemas/moderation.schema.js';
import * as moderationService from '../services/moderation.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/admin/message-flags */
export async function listFlags(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<AdminListModerationFlagsQuery>(req);
  const { flags, total } = await moderationService.listModerationFlags(query);
  sendPaginated(res, flags, buildPaginationMeta(query.page, query.limit, total));
}

/** PATCH /api/v1/admin/message-flags/:id/review */
export async function reviewFlag(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const body = validatedBody<ReviewModerationFlagBody>(req);
  const flag = await moderationService.reviewModerationFlag(requireUserId(req), id, body);
  sendData(res, flag);
}
