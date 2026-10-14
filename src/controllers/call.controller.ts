import type { Request, Response } from 'express';

import { validatedParams, validatedQuery } from '../middleware/validate.js';
import type { ListCallsQuery } from '../schemas/call.schema.js';
import * as callService from '../services/call.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/calls/config */
export function getCallConfig(req: Request, res: Response): void {
  sendData(res, callService.getCallConfig(requireUserId(req)));
}

/**
 * GET /api/v1/conversations/:id/calls
 *
 * Call log for the conversation. Membership (and the booking being usable) is
 * re-checked on every request, exactly like reading messages.
 */
export async function listConversationCalls(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const query = validatedQuery<ListCallsQuery>(req);
  const { calls, total } = await callService.listConversationCalls(requireUserId(req), id, query);
  sendPaginated(res, calls, buildPaginationMeta(query.page, query.limit, total));
}
