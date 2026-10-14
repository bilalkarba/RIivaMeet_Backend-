import { prisma } from '../config/prisma.js';
import { ReportStatus, ReportTargetType } from '../generated/prisma/enums.js';
import type {
  AdminListReportsQuery,
  CreateReportBody,
  ListMyReportsQuery,
} from '../schemas/safety.schema.js';
import { ApiError } from '../utils/errors.js';
import {
  toAdminReportResponse,
  toReportResponse,
  type AdminReportResponse,
  type ReportResponse,
} from '../utils/presenters.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';

/**
 * Reporting service (Phase 2).
 *
 * Only the reporter and admins can read a report. The reporter's projection never
 * contains reviewer identity or internal notes beyond the resolution message, and the
 * admin projection is only reachable through role-protected routes.
 *
 * USER reports are fully supported. POST/MESSAGE targets are accepted by the schema so
 * the contract is stable, but the service rejects them until those entities exist -
 * reporting a record that cannot exist would be a fake feature.
 */

const ADMIN_INCLUDE = {
  reporter: { select: { id: true, name: true, displayName: true } },
  targetUser: { select: { id: true, name: true, displayName: true } },
  reviewedBy: { select: { id: true, name: true, displayName: true } },
} as const;

export async function createReport(reporterId: string, input: CreateReportBody): Promise<ReportResponse> {
  let targetUserId: string | null = null;

  if (input.targetType === ReportTargetType.USER) {
    if (input.targetId === reporterId) {
      throw ApiError.badRequest('You cannot report yourself');
    }
    const target = await prisma.user.findUnique({ where: { id: input.targetId }, select: { id: true } });
    if (!target) {
      throw ApiError.notFound('User not found');
    }
    targetUserId = target.id;
  } else {
    throw ApiError.badRequest(
      `Reporting ${input.targetType} targets is not available yet`,
      { supportedTargetTypes: [ReportTargetType.USER] },
    );
  }

  const existing = await prisma.report.findFirst({
    where: { reporterId, targetType: input.targetType, targetId: input.targetId, status: ReportStatus.PENDING },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict('You already have a pending report for this target', { reportId: existing.id });
  }

  try {
    const report = await prisma.report.create({
      data: {
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        targetUserId,
        reason: input.reason,
        description: input.description ?? null,
      },
    });
    return toReportResponse(report);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw ApiError.conflict('This report already exists');
    }
    throw error;
  }
}

export async function listMyReports(
  reporterId: string,
  query: ListMyReportsQuery,
): Promise<{ reports: ReportResponse[]; total: number }> {
  const where = { reporterId, ...(query.status ? { status: query.status } : {}) };

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const reports = await tx.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.report.count({ where });
    return [reports, count] as const;
  });

  return { reports: rows.map(toReportResponse), total };
}

export async function getMyReport(reporterId: string, reportId: string): Promise<ReportResponse> {
  const report = await prisma.report.findFirst({ where: { id: reportId, reporterId } });
  if (!report) {
    throw ApiError.notFound('Report not found');
  }
  return toReportResponse(report);
}

// ---------------------------------------------------------------------------
// Admin moderation
// ---------------------------------------------------------------------------

export async function listReportsForAdmin(
  query: AdminListReportsQuery,
): Promise<{ reports: AdminReportResponse[]; total: number }> {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
  };

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const reports = await tx.report.findMany({
      where,
      include: ADMIN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.report.count({ where });
    return [reports, count] as const;
  });

  return { reports: rows.map(toAdminReportResponse), total };
}

export async function getReportForAdmin(reportId: string): Promise<AdminReportResponse> {
  const report = await prisma.report.findUnique({ where: { id: reportId }, include: ADMIN_INCLUDE });
  if (!report) {
    throw ApiError.notFound('Report not found');
  }
  return toAdminReportResponse(report);
}

export async function decideReport(
  adminId: string,
  reportId: string,
  decision: typeof ReportStatus.RESOLVED | typeof ReportStatus.REJECTED,
  note?: string,
): Promise<AdminReportResponse> {
  const existing = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true, status: true } });
  if (!existing) {
    throw ApiError.notFound('Report not found');
  }
  if (existing.status !== ReportStatus.PENDING) {
    throw ApiError.conflict(`This report has already been ${existing.status.toLowerCase()}`, {
      currentStatus: existing.status,
    });
  }

  const updated = await prisma.report.update({
    where: { id: reportId },
    data: {
      status: decision,
      reviewedById: adminId,
      reviewedAt: new Date(),
      ...(note === undefined ? {} : { resolutionNote: note }),
    },
    include: ADMIN_INCLUDE,
  });

  return toAdminReportResponse(updated);
}
