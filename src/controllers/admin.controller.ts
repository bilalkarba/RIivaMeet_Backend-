import type { Request, Response } from 'express';

import { ReportStatus } from '../generated/prisma/enums.js';
import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type { AdminListReportsQuery, ResolveReportBody } from '../schemas/safety.schema.js';
import * as reportService from '../services/report.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/admin/reports */
export async function listReports(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<AdminListReportsQuery>(req);
  const { reports, total } = await reportService.listReportsForAdmin(query);
  sendPaginated(res, reports, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/admin/reports/:id */
export async function getReport(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const report = await reportService.getReportForAdmin(id);
  sendData(res, report);
}

/** PATCH /api/v1/admin/reports/:id/resolve */
export async function resolveReport(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { note } = validatedBody<ResolveReportBody>(req);
  const report = await reportService.decideReport(requireUserId(req), id, ReportStatus.RESOLVED, note);
  sendData(res, report);
}

/** PATCH /api/v1/admin/reports/:id/reject */
export async function rejectReport(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { note } = validatedBody<ResolveReportBody>(req);
  const report = await reportService.decideReport(requireUserId(req), id, ReportStatus.REJECTED, note);
  sendData(res, report);
}
