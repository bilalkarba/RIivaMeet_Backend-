import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type {
  BlockBody,
  CreateReportBody,
  ListMyReportsQuery,
} from '../schemas/safety.schema.js';
import * as blockService from '../services/block.service.js';
import * as reportService from '../services/report.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** POST /api/v1/blocks */
export async function blockUser(req: Request, res: Response): Promise<void> {
  const { userId } = validatedBody<BlockBody>(req);
  const blocks = await blockService.blockUser(requireUserId(req), userId);
  sendCreated(res, blocks);
}

/** GET /api/v1/blocks */
export async function listBlocks(req: Request, res: Response): Promise<void> {
  const blocks = await blockService.listBlocks(requireUserId(req));
  sendData(res, blocks);
}

/** DELETE /api/v1/blocks/:userId */
export async function unblockUser(req: Request, res: Response): Promise<void> {
  const { userId } = validatedParams<{ userId: string }>(req);
  const blocks = await blockService.unblockUser(requireUserId(req), userId);
  sendData(res, blocks);
}

/** POST /api/v1/reports */
export async function createReport(req: Request, res: Response): Promise<void> {
  const body = validatedBody<CreateReportBody>(req);
  const report = await reportService.createReport(requireUserId(req), body);
  sendCreated(res, report);
}

/** GET /api/v1/reports/mine */
export async function listMyReports(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListMyReportsQuery>(req);
  const { reports, total } = await reportService.listMyReports(requireUserId(req), query);
  sendPaginated(res, reports, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/reports/:id */
export async function getMyReport(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const report = await reportService.getMyReport(requireUserId(req), id);
  sendData(res, report);
}
