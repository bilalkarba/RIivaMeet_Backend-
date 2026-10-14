import type { Request, Response } from 'express';

import { validatedQuery } from '../middleware/validate.js';
import type { SuggestionsQuery } from '../schemas/profile.schema.js';
import { getRelatedUserIds } from '../services/block.service.js';
import { suggestCompatibleCoaches } from '../services/match.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendPaginated } from '../utils/http.js';

/** GET /api/v1/matches/suggestions */
export async function listSuggestions(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw ApiError.unauthorized();
  }

  const query = validatedQuery<SuggestionsQuery>(req);
  // Blocked accounts never surface in personalised discovery.
  const excludeUserIds = await getRelatedUserIds(req.user.id);
  const { coaches, total, basis } = await suggestCompatibleCoaches(req.user, query, { excludeUserIds });

  sendPaginated(res, coaches, {
    ...buildPaginationMeta(query.page, query.limit, total),
    basis,
  });
}
