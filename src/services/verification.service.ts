import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  Role,
  VerificationDocumentType,
  VerificationEventType,
  VerificationStatus,
} from '../generated/prisma/enums.js';
import type {
  AdminListVerificationsQuery,
  ListUnverifiedCoachesQuery,
  StartDocumentUploadBody,
} from '../schemas/verification.schema.js';
import { ApiError } from '../utils/errors.js';
import {
  emptyCoachVerification,
  toAdminVerificationDetail,
  toAdminVerificationSummary,
  toAdminVerificationSummaryFromRow,
  toCoachVerification,
  toPublicVerificationStatus,
  type AdminVerificationDetailResponse,
  type AdminVerificationSummaryResponse,
  type CoachVerificationResponse,
  type PublicVerificationStatusResponse,
  type VerificationDocumentRow,
  type VerificationEventRow,
  type VerificationRow,
  type VerificationStorageRow,
} from '../utils/presenters.js';
import { requireCoachProfileId } from './coach.service.js';
import {
  createDocumentUploadTarget,
  deletePrivateObject,
  detectDocumentContentType,
  headPrivateObject,
  isAllowedDocumentContentType,
  readPrivateObjectHeadBytes,
  type DocumentUploadTarget,
} from './storage.service.js';

/**
 * Coach verification service.
 *
 * Lifecycle (see `VerificationStatus` in schema.prisma):
 *
 *   DRAFT --submit--> PENDING --markInReview--> IN_REVIEW --approve--> APPROVED
 *     ^                 |                            |--reject--> REJECTED --resubmit--+
 *     |                 |--requestInfo--> NEEDS_INFO -+                                  |
 *     +-----------------+--reject--> REJECTED -------- resubmit ------------------------+
 *
 * Only an ADMIN can move an application to APPROVED/REJECTED. Approval does NOT publish a profile: the existing publication rules
 * (coordinates + at least one sport) still apply, and discovery requires APPROVED.
 */

/** Documents may only be changed while the application is editable. */
const EDITABLE_STATUSES: VerificationStatus[] = [
  VerificationStatus.DRAFT,
  VerificationStatus.NEEDS_INFO,
  VerificationStatus.REJECTED,
];

/** Statuses a coach may submit/resubmit from. */
const SUBMITTABLE_STATUSES: VerificationStatus[] = [
  VerificationStatus.DRAFT,
  VerificationStatus.NEEDS_INFO,
  VerificationStatus.REJECTED,
];

/** Statuses an administrator may decide on. */
const DECIDABLE_STATUSES: VerificationStatus[] = [
  VerificationStatus.PENDING,
  VerificationStatus.IN_REVIEW,
];

/** Abandoned unconfirmed uploads are cleaned up after this long. */
const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

const VERIFICATION_INCLUDE = {
  documents: { orderBy: { uploadedAt: 'desc' } },
  events: { orderBy: { createdAt: 'desc' }, take: 50 },
} as const;

const ADMIN_INCLUDE = {
  coachProfile: {
    include: {
      user: { select: { id: true, name: true, email: true, displayName: true } },
      sports: { include: { sport: { select: { id: true, name: true, slug: true } } } },
    },
  },
  reviewedBy: { select: { id: true, name: true, displayName: true } },
  _count: { select: { documents: true } },
} as const;

function requiredDocumentTypes(): VerificationDocumentType[] {
  return env.verificationRequiredDocumentTypes as VerificationDocumentType[];
}

/** Which requirements are still unsatisfied for a submission. */
function unmetRequirements(documents: { type: VerificationDocumentType; isCurrent: boolean; confirmedAt: Date | null }[]): string[] {
  const usable = documents.filter((document) => document.isCurrent && document.confirmedAt !== null);

  if (usable.length === 0) {
    return ['At least one confirmed document is required'];
  }

  const required = requiredDocumentTypes();
  if (required.length === 0) {
    return [];
  }

  const present = new Set(usable.map((document) => document.type));
  if (required.some((type) => present.has(type))) {
    return [];
  }

  return [`A document of type ${required.join(' or ')} is required`];
}

// ---------------------------------------------------------------------------
// Coach-facing
// ---------------------------------------------------------------------------

export async function getMyVerification(userId: string): Promise<CoachVerificationResponse> {
  const coachProfileId = await requireCoachProfileId(userId);

  const verification = await prisma.coachVerification.findUnique({
    where: { coachProfileId },
    include: VERIFICATION_INCLUDE,
  });

  if (!verification) {
    return emptyCoachVerification(requiredDocumentTypes());
  }

  return toCoachVerification(verification, {
    missingRequirements: unmetRequirements(verification.documents),
    requiredDocumentTypes: requiredDocumentTypes(),
  });
}

/**
 * Step 1 of an upload: create the private object target.
 *
 * The key is generated server-side, so the client never influences the storage path. The
 * document row stays unconfirmed (and invisible to admins) until `confirmDocumentUpload`
 * verifies the object really exists in storage.
 */
export async function startDocumentUpload(
  userId: string,
  input: StartDocumentUploadBody,
): Promise<{ verification: CoachVerificationResponse; upload: DocumentUploadTarget; documentId: string }> {
  if (!isAllowedDocumentContentType(input.contentType)) {
    throw ApiError.badRequest(`Unsupported document type "${input.contentType}". Allowed: application/pdf, image/jpeg, image/png`);
  }

  const coachProfileId = await requireCoachProfileId(userId);

  const verification = await prisma.coachVerification.findUnique({
    where: { coachProfileId },
    select: { id: true, status: true },
  });

  if (verification && !EDITABLE_STATUSES.includes(verification.status)) {
    throw ApiError.conflict(
      'Documents cannot be changed while the application is under review or already decided',
      { currentStatus: verification.status, editableFrom: EDITABLE_STATUSES },
    );
  }

  const verificationId =
    verification?.id ?? (await createVerificationRow(coachProfileId, userId)).id;

  await cleanupAbandonedUploads(verificationId);

  const upload = await createDocumentUploadTarget({
    verificationId,
    contentType: input.contentType,
  });

  const document = await prisma.coachVerificationDocument.create({
    data: {
      verificationId,
      type: input.type,
      storageProvider: upload.storageProvider,
      storageBucket: upload.storageBucket,
      storageKey: upload.key,
      originalFileName: sanitizeFileName(input.fileName),
      contentType: input.contentType,
      isCurrent: false,
    },
  });

  const fresh = await prisma.coachVerification.findUniqueOrThrow({
    where: { id: verificationId },
    include: VERIFICATION_INCLUDE,
  });

  return {
    verification: toCoachVerification(fresh, {
      missingRequirements: unmetRequirements(fresh.documents),
      requiredDocumentTypes: requiredDocumentTypes(),
    }),
    upload,
    documentId: document.id,
  };
}

/**
 * Step 2 of an upload: verify the object exists, is within the size limit, and really is
 * the declared file type (file-signature check). Only then does the document become
 * "current" and therefore visible to admins and eligible for analysis.
 */
export async function confirmDocumentUpload(userId: string, documentId: string): Promise<CoachVerificationResponse> {
  const coachProfileId = await requireCoachProfileId(userId);

  const document = await prisma.coachVerificationDocument.findFirst({
    where: { id: documentId, verification: { coachProfileId } },
    include: { verification: { select: { id: true, status: true } } },
  });

  if (!document) {
    // Also covers documents that belong to another coach's application (no IDOR).
    throw ApiError.notFound('Document not found');
  }

  if (!EDITABLE_STATUSES.includes(document.verification.status)) {
    throw ApiError.conflict('Documents cannot be changed while the application is under review or already decided', {
      currentStatus: document.verification.status,
    });
  }

  if (document.isCurrent && document.confirmedAt) {
    return getMyVerification(userId);
  }

  const head = await headPrivateObject(document.storageKey).catch(() => null);
  if (!head) {
    await discardDocument(document.id, document.storageKey);
    throw ApiError.badRequest('The upload could not be found in storage. Please upload the document again.', {
      documentId,
    });
  }

  if (head.sizeBytes <= 0) {
    await discardDocument(document.id, document.storageKey);
    throw ApiError.badRequest('The uploaded file is empty');
  }

  const maxBytes = env.STORAGE_DOCUMENT_MAX_UPLOAD_BYTES;
  if (head.sizeBytes > maxBytes) {
    await discardDocument(document.id, document.storageKey);
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `The document exceeds the maximum size of ${maxBytes} bytes`, {
      maxBytes,
    });
  }

  // Independent file-signature check: the stored bytes must match the declared type.
  const headBytes = await readPrivateObjectHeadBytes(document.storageKey).catch(() => Buffer.alloc(0));
  const detected = detectDocumentContentType(headBytes);
  if (!detected || detected !== document.contentType) {
    await discardDocument(document.id, document.storageKey);
    throw ApiError.badRequest(
      'The uploaded file content does not match its declared type (allowed: PDF, JPEG, PNG)',
      { declaredContentType: document.contentType, detectedContentType: detected },
    );
  }

  await prisma.$transaction(async (tx) => {
    // Replacing a document: the previous one of the same type stops being current but is
    // kept for the audit trail (and stays on disk until it is explicitly removed).
    await tx.coachVerificationDocument.updateMany({
      where: {
        verificationId: document.verificationId,
        type: document.type,
        isCurrent: true,
        id: { not: document.id },
      },
      data: { isCurrent: false },
    });

    await tx.coachVerificationDocument.update({
      where: { id: document.id },
      data: { isCurrent: true, confirmedAt: new Date(), sizeBytes: head.sizeBytes },
    });

    await tx.coachVerificationEvent.create({
      data: {
        verificationId: document.verificationId,
        type: VerificationEventType.DOCUMENT_UPLOADED,
        actorUserId: userId,
        actorRole: Role.COACH,
        metadata: { documentId: document.id, documentType: document.type, sizeBytes: head.sizeBytes } as never,
      },
    });
  });

  return getMyVerification(userId);
}

export async function removeDocument(userId: string, documentId: string): Promise<CoachVerificationResponse> {
  const coachProfileId = await requireCoachProfileId(userId);

  const document = await prisma.coachVerificationDocument.findFirst({
    where: { id: documentId, verification: { coachProfileId } },
    include: { verification: { select: { id: true, status: true } } },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  if (!EDITABLE_STATUSES.includes(document.verification.status)) {
    throw ApiError.conflict('Documents cannot be changed while the application is under review or already decided', {
      currentStatus: document.verification.status,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.coachVerificationDocument.delete({ where: { id: document.id } });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId: document.verificationId,
        type: VerificationEventType.DOCUMENT_REMOVED,
        actorUserId: userId,
        actorRole: Role.COACH,
        metadata: { documentId: document.id, documentType: document.type } as never,
      },
    });
  });

  // Best-effort: the object is removed, but a storage hiccup never fails the request.
  await deletePrivateObject(document.storageKey);

  return getMyVerification(userId);
}

/** Submit (or resubmit) the application for review. */
export async function submitVerification(userId: string): Promise<CoachVerificationResponse> {
  const coachProfileId = await requireCoachProfileId(userId);

  const verification = await prisma.coachVerification.findUnique({
    where: { coachProfileId },
    include: { documents: true },
  });

  if (!verification) {
    throw ApiError.badRequest('Upload at least one document before submitting your verification');
  }

  if (!SUBMITTABLE_STATUSES.includes(verification.status)) {
    throw ApiError.conflict('This application is already submitted', {
      currentStatus: verification.status,
      submittableFrom: SUBMITTABLE_STATUSES,
    });
  }

  const missing = unmetRequirements(verification.documents);
  if (missing.length > 0) {
    throw ApiError.badRequest('This application does not meet the document requirements yet', {
      problems: missing,
      requiredDocumentTypes: requiredDocumentTypes(),
    });
  }

  const isResubmission = verification.submittedAt !== null;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verification.id },
      data: {
        status: VerificationStatus.PENDING,
        submittedAt: verification.submittedAt ?? now,
        lastSubmittedAt: now,
        // A resubmission is a fresh review: clear the previous administrator decision.
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });

    await tx.coachVerificationEvent.create({
      data: {
        verificationId: verification.id,
        type: isResubmission ? VerificationEventType.RESUBMITTED : VerificationEventType.SUBMITTED,
        fromStatus: verification.status,
        toStatus: VerificationStatus.PENDING,
        actorUserId: userId,
        actorRole: Role.COACH,
        metadata: { documentCount: verification.documents.filter((document) => document.isCurrent).length } as never,
      },
    });
  });

  return getMyVerification(userId);
}

/** Public status projection used by the coach's own dashboard header and the admin list. */
export async function getPublicVerificationStatus(userId: string): Promise<PublicVerificationStatusResponse> {
  const profile = await prisma.coachProfile.findUnique({
    where: { userId },
    select: { id: true, isPublished: true, verification: { select: { status: true } } },
  });

  const status = profile?.verification?.status ?? null;

  return toPublicVerificationStatus({
    status,
    isPublished: profile?.isPublished ?? false,
    isPubliclyVisible: Boolean(profile?.isPublished) && status === VerificationStatus.APPROVED,
  });
}

// ---------------------------------------------------------------------------
// Admin-facing
// ---------------------------------------------------------------------------

export async function listForAdmin(
  query: AdminListVerificationsQuery,
): Promise<{ items: AdminVerificationSummaryResponse[]; total: number }> {
  const where: Prisma.CoachVerificationWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.coachProfileId ? { coachProfileId: query.coachProfileId } : {}),
    ...(query.submittedFrom || query.submittedTo
      ? {
          submittedAt: {
            ...(query.submittedFrom ? { gte: query.submittedFrom } : {}),
            ...(query.submittedTo ? { lte: query.submittedTo } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const items = await tx.coachVerification.findMany({
      where,
      include: ADMIN_INCLUDE,
      orderBy: [{ lastSubmittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.coachVerification.count({ where });
    return [items, count] as const;
  });

  return { items: rows.map(toAdminVerificationSummaryFromRow), total };
}

export async function getForAdmin(verificationId: string): Promise<AdminVerificationDetailResponse> {
  const verification = await prisma.coachVerification.findUnique({
    where: { id: verificationId },
    include: { ...ADMIN_INCLUDE, ...VERIFICATION_INCLUDE },
  });

  if (!verification) {
    throw ApiError.notFound('Verification application not found');
  }

  return toAdminVerificationDetail(verification);
}

/** Published coaches that are not (or not yet) approved - the deliberate rollout queue. */
export async function listUnverifiedCoaches(
  query: ListUnverifiedCoachesQuery,
): Promise<{ items: AdminVerificationSummaryResponse[]; total: number }> {
  const where: Prisma.CoachProfileWhereInput = {
    isPublished: true,
    NOT: { verification: { is: { status: VerificationStatus.APPROVED } } },
    ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
    ...(query.search
      ? {
          OR: [
            { user: { name: { contains: query.search, mode: 'insensitive' } } },
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [profiles, total] = await prisma.$transaction(async (tx) => {
    const rows = await tx.coachProfile.findMany({
      where,
      select: {
        id: true,
        isPublished: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, displayName: true } },
        verification: { include: ADMIN_INCLUDE },
      },
      orderBy: { createdAt: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.coachProfile.count({ where });
    return [rows, count] as const;
  });

  const items = profiles.map((profile) => {
    if (!profile.verification) {
      // No application row at all: the profile predates verification (or the coach never
      // started one). `status` is reported as NOT_SUBMITTED and it stays invisible to
      // clients until an administrator approves it explicitly.
      return toAdminVerificationSummary({
        id: null,
        coachProfileId: profile.id,
        status: VerificationStatus.DRAFT,
        submittedAt: null,
        lastSubmittedAt: null,
        reviewNote: null,
        reviewedAt: null,
        updatedAt: profile.createdAt,
        isPublished: profile.isPublished,
        coach: profile.user,
        documentCount: 0,
      });
    }
    return toAdminVerificationSummaryFromRow(profile.verification);
  });

  return { items, total };
}

export async function markInReview(adminId: string, verificationId: string): Promise<AdminVerificationDetailResponse> {
  const existing = await requireVerification(verificationId);

  if (!DECIDABLE_STATUSES.includes(existing.status)) {
    throw ApiError.conflict('Only a pending application can be marked as in review', {
      currentStatus: existing.status,
      allowedFrom: DECIDABLE_STATUSES,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verificationId },
      data: { status: VerificationStatus.IN_REVIEW },
    });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId,
        type: VerificationEventType.MARKED_IN_REVIEW,
        fromStatus: existing.status,
        toStatus: VerificationStatus.IN_REVIEW,
        actorUserId: adminId,
        actorRole: Role.ADMIN,
      },
    });
  });

  return getForAdmin(verificationId);
}

export async function approve(
  adminId: string,
  verificationId: string,
  note?: string,
): Promise<AdminVerificationDetailResponse> {
  const existing = await requireVerification(verificationId);

  if (!DECIDABLE_STATUSES.includes(existing.status)) {
    throw ApiError.conflict('Only a pending or in-review application can be approved', {
      currentStatus: existing.status,
      allowedFrom: DECIDABLE_STATUSES,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verificationId },
      data: {
        status: VerificationStatus.APPROVED,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      },
    });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId,
        type: VerificationEventType.APPROVED,
        fromStatus: existing.status,
        toStatus: VerificationStatus.APPROVED,
        actorUserId: adminId,
        actorRole: Role.ADMIN,
        note: note ?? null,
      },
    });
  });

  // Approval never publishes a profile: `isPublished` and its requirements are untouched.
  return getForAdmin(verificationId);
}

export async function reject(
  adminId: string,
  verificationId: string,
  note: string,
): Promise<AdminVerificationDetailResponse> {
  const existing = await requireVerification(verificationId);

  if (
    !DECIDABLE_STATUSES.includes(existing.status) &&
    existing.status !== VerificationStatus.NEEDS_INFO
  ) {
    throw ApiError.conflict('This application cannot be rejected in its current state', {
      currentStatus: existing.status,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verificationId },
      data: {
        status: VerificationStatus.REJECTED,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId,
        type: VerificationEventType.REJECTED,
        fromStatus: existing.status,
        toStatus: VerificationStatus.REJECTED,
        actorUserId: adminId,
        actorRole: Role.ADMIN,
        note,
      },
    });
  });

  return getForAdmin(verificationId);
}

export async function requestInfo(
  adminId: string,
  verificationId: string,
  note: string,
): Promise<AdminVerificationDetailResponse> {
  const existing = await requireVerification(verificationId);

  if (!DECIDABLE_STATUSES.includes(existing.status)) {
    throw ApiError.conflict('Only a pending or in-review application can request more information', {
      currentStatus: existing.status,
      allowedFrom: DECIDABLE_STATUSES,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verificationId },
      // NEEDS_INFO is undecided by design (no reviewer columns, see the CHECK constraint);
      // the requesting administrator is recorded in the audit event.
      data: { status: VerificationStatus.NEEDS_INFO, reviewNote: note },
    });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId,
        type: VerificationEventType.INFO_REQUESTED,
        fromStatus: existing.status,
        toStatus: VerificationStatus.NEEDS_INFO,
        actorUserId: adminId,
        actorRole: Role.ADMIN,
        note,
      },
    });
  });

  return getForAdmin(verificationId);
}

/**
 * Deliberate handling of coaches that existed before verification was introduced: an
 * administrator can record an explicit, auditable approval for them.
 *
 * This is never automatic - no migration or background job approves anybody - and it
 * requires an admin action with a reason so the decision is traceable.
 */
export async function grandfatherApproval(
  adminId: string,
  coachProfileId: string,
  note: string,
): Promise<AdminVerificationDetailResponse> {
  const profile = await prisma.coachProfile.findUnique({
    where: { id: coachProfileId },
    select: { id: true, verification: { select: { id: true, status: true } } },
  });

  if (!profile) {
    throw ApiError.notFound('Coach profile not found');
  }

  if (profile.verification?.status === VerificationStatus.APPROVED) {
    throw ApiError.conflict('This coach is already verified');
  }

  const now = new Date();

  const verificationId =
    profile.verification?.id ??
    (
      await prisma.coachVerification.create({
        data: {
          coachProfileId,
          status: VerificationStatus.DRAFT,
          events: {
            create: {
              type: VerificationEventType.APPLICATION_STARTED,
              actorUserId: adminId,
              actorRole: Role.ADMIN,
              metadata: { source: 'GRANDFATHERED' } as never,
            },
          },
        },
        select: { id: true },
      })
    ).id;

  await prisma.$transaction(async (tx) => {
    await tx.coachVerification.update({
      where: { id: verificationId },
      data: {
        status: VerificationStatus.APPROVED,
        submittedAt: now,
        lastSubmittedAt: now,
        reviewedById: adminId,
        reviewedAt: now,
        reviewNote: note,
      },
    });
    await tx.coachVerificationEvent.create({
      data: {
        verificationId,
        type: VerificationEventType.APPROVED,
        fromStatus: profile.verification?.status ?? null,
        toStatus: VerificationStatus.APPROVED,
        actorUserId: adminId,
        actorRole: Role.ADMIN,
        note,
        metadata: { source: 'GRANDFATHERED' } as never,
      },
    });
  });

  return getForAdmin(verificationId);
}

/** Loads the storage metadata an administrator needs to stream a private document. */
export async function getDocumentForAdmin(documentId: string): Promise<VerificationStorageRow> {
  const document = await prisma.coachVerificationDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      verificationId: true,
      storageKey: true,
      storageProvider: true,
      storageBucket: true,
      contentType: true,
      originalFileName: true,
      sizeBytes: true,
      isCurrent: true,
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  return document;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function requireVerification(verificationId: string): Promise<{ id: string; status: VerificationStatus }> {
  const verification = await prisma.coachVerification.findUnique({
    where: { id: verificationId },
    select: { id: true, status: true },
  });

  if (!verification) {
    throw ApiError.notFound('Verification application not found');
  }

  return verification;
}

async function createVerificationRow(coachProfileId: string, actorUserId: string): Promise<{ id: string }> {
  return prisma.coachVerification.create({
    data: {
      coachProfileId,
      status: VerificationStatus.DRAFT,
      events: {
        create: {
          type: VerificationEventType.APPLICATION_STARTED,
          actorUserId,
          actorRole: Role.COACH,
        },
      },
    },
    select: { id: true },
  });
}

/** Remove an unconfirmed document row plus its object (used when validation fails). */
async function discardDocument(documentId: string, storageKey: string): Promise<void> {
  await prisma.coachVerificationDocument.delete({ where: { id: documentId } }).catch(() => undefined);
  await deletePrivateObject(storageKey);
}

/** Delete uploads that were started but never confirmed, so abandoned files do not pile up. */
async function cleanupAbandonedUploads(verificationId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_MS);

  const abandoned = await prisma.coachVerificationDocument.findMany({
    where: { verificationId, confirmedAt: null, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true },
  });

  if (abandoned.length === 0) {
    return;
  }

  await prisma.coachVerificationDocument.deleteMany({
    where: { id: { in: abandoned.map((document) => document.id) } },
  });

  for (const document of abandoned) {
    await deletePrivateObject(document.storageKey);
  }
}

/** Keep only a display name: no path separators, no control characters, bounded length. */
function sanitizeFileName(fileName: string | undefined): string | null {
  if (!fileName) {
    return null;
  }
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : null;
}

export type { VerificationDocumentRow, VerificationEventRow, VerificationRow };
