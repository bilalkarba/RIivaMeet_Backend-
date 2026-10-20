import { z } from 'zod';

import { VerificationDocumentType, VerificationStatus } from '../generated/prisma/enums.js';
import { limitQuery, pageQuery, trimmedString, uuidSchema } from './common.schema.js';

/**
 * Coach verification request schemas.
 *
 * `code`/`role`/`status` are never read from a body: the status transitions are decided by
 * the service from the stored row and the authenticated admin, so a client cannot approve
 * itself.
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Optional ISO-8601 filter parsed into a `Date` (used by the admin queue). */
const optionalDateQuery = z.preprocess(
  emptyToUndefined,
  z.iso
    .datetime({ offset: true, message: 'Must be an ISO 8601 timestamp with an explicit offset' })
    .transform((value) => new Date(value))
    .optional(),
);

const enumQuery = <T extends string>(values: readonly T[]) =>
  z.preprocess(emptyToUndefined, z.enum(values as unknown as [T, ...T[]]).optional());

export const startDocumentUploadBodySchema = z
  .object({
    type: z.enum(VerificationDocumentType),
    /** Only PDF/JPEG/PNG are accepted; the stored bytes are re-checked against the file signature. */
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png'], {
      message: 'contentType must be application/pdf, image/jpeg or image/png',
    }),
    /** Display name only - never used to build the storage key. */
    fileName: trimmedString(1, 200).optional(),
  })
  .strict();

export const verificationDocumentParamSchema = z.object({ documentId: uuidSchema });

export const adminListVerificationsQuerySchema = z
  .object({
    status: enumQuery(Object.values(VerificationStatus)),
    coachProfileId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    submittedFrom: optionalDateQuery,
    submittedTo: optionalDateQuery,
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const listUnverifiedCoachesQuerySchema = z
  .object({
    city: z.preprocess(emptyToUndefined, trimmedString(1, 80).optional()),
    search: z.preprocess(emptyToUndefined, trimmedString(2, 120).optional()),
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const adminDecisionBodySchema = z
  .object({
    note: trimmedString(3, 2000).optional(),
  })
  .strict();

export const adminRejectBodySchema = z
  .object({
    /** A rejection reason is mandatory so the coach knows what to correct. */
    note: trimmedString(3, 2000),
  })
  .strict();

export const adminRequestInfoBodySchema = z
  .object({
    note: trimmedString(3, 2000),
  })
  .strict();

export const grandfatherApprovalBodySchema = z
  .object({
    coachProfileId: uuidSchema,
    note: trimmedString(3, 2000),
  })
  .strict();

export type StartDocumentUploadBody = z.infer<typeof startDocumentUploadBodySchema>;
export type AdminListVerificationsQuery = z.infer<typeof adminListVerificationsQuerySchema>;
export type ListUnverifiedCoachesQuery = z.infer<typeof listUnverifiedCoachesQuerySchema>;
export type AdminDecisionBody = z.infer<typeof adminDecisionBodySchema>;
export type AdminRejectBody = z.infer<typeof adminRejectBodySchema>;
export type AdminRequestInfoBody = z.infer<typeof adminRequestInfoBodySchema>;
export type GrandfatherApprovalBody = z.infer<typeof grandfatherApprovalBodySchema>;
