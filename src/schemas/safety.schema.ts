import { z } from 'zod';

import { ReportReason, ReportStatus, ReportTargetType } from '../generated/prisma/enums.js';
import { limitQuery, pageQuery, trimmedString, uuidSchema } from './common.schema.js';

export const blockBodySchema = z.object({ userId: uuidSchema }).strict();

export const createReportBodySchema = z
  .object({
    targetType: z.enum(ReportTargetType),
    /**
     * Id of the reported entity. For USER reports this is the user id; the service
     * forces `targetUserId` to match so moderation queries stay exact.
     */
    targetId: uuidSchema,
    reason: z.enum(ReportReason),
    description: trimmedString(3, 2000).optional(),
  })
  .strict();

const reportStatusQuery = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.enum(ReportStatus).optional(),
);

const reportTargetTypeQuery = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.enum(ReportTargetType).optional(),
);

export const listMyReportsQuerySchema = z
  .object({
    status: reportStatusQuery,
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const adminListReportsQuerySchema = z
  .object({
    status: reportStatusQuery,
    targetType: reportTargetTypeQuery,
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const resolveReportBodySchema = z
  .object({
    note: trimmedString(3, 2000).optional(),
  })
  .strict();

export type BlockBody = z.infer<typeof blockBodySchema>;
export type CreateReportBody = z.infer<typeof createReportBodySchema>;
export type ListMyReportsQuery = z.infer<typeof listMyReportsQuerySchema>;
export type AdminListReportsQuery = z.infer<typeof adminListReportsQuerySchema>;
export type ResolveReportBody = z.infer<typeof resolveReportBodySchema>;
