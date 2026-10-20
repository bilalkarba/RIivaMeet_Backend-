import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type {
  AdminListVerificationsQuery,
  AdminRejectBody,
  GrandfatherApprovalBody,
  ListUnverifiedCoachesQuery,
  StartDocumentUploadBody,
} from '../schemas/verification.schema.js';
import * as storageService from '../services/storage.service.js';
import * as verificationService from '../services/verification.service.js';
import type { AuthenticatedUser } from '../utils/jwt.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendData, sendPaginated } from '../utils/http.js';

function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user;
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

/** GET /api/v1/coaches/me/verification */
export async function getMyVerification(req: Request, res: Response): Promise<void> {
  const verification = await verificationService.getMyVerification(requireUser(req).id);
  sendData(res, verification);
}

/** GET /api/v1/coaches/me/verification/status */
export async function getMyStatus(req: Request, res: Response): Promise<void> {
  const status = await verificationService.getPublicVerificationStatus(requireUser(req).id);
  sendData(res, status);
}

/** POST /api/v1/coaches/me/verification/documents */
export async function startDocumentUpload(req: Request, res: Response): Promise<void> {
  const body = validatedBody<StartDocumentUploadBody>(req);
  const result = await verificationService.startDocumentUpload(requireUser(req).id, body);
  sendCreated(res, result);
}

/** POST /api/v1/coaches/me/verification/documents/:documentId/confirm */
export async function confirmDocumentUpload(req: Request, res: Response): Promise<void> {
  const { documentId } = validatedParams<{ documentId: string }>(req);
  const verification = await verificationService.confirmDocumentUpload(requireUser(req).id, documentId);
  sendData(res, verification);
}

/** DELETE /api/v1/coaches/me/verification/documents/:documentId */
export async function removeDocument(req: Request, res: Response): Promise<void> {
  const { documentId } = validatedParams<{ documentId: string }>(req);
  const verification = await verificationService.removeDocument(requireUser(req).id, documentId);
  sendData(res, verification);
}

/** POST /api/v1/coaches/me/verification/submit */
export async function submitVerification(req: Request, res: Response): Promise<void> {
  const verification = await verificationService.submitVerification(requireUser(req).id);
  sendData(res, verification);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** GET /api/v1/admin/verifications */
export async function listVerifications(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<AdminListVerificationsQuery>(req);
  const { items, total } = await verificationService.listForAdmin(query);
  sendPaginated(res, items, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/admin/verifications/unverified-coaches */
export async function listUnverifiedCoaches(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListUnverifiedCoachesQuery>(req);
  const { items, total } = await verificationService.listUnverifiedCoaches(query);
  sendPaginated(res, items, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/admin/verifications/:id */
export async function getVerification(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const verification = await verificationService.getForAdmin(id);
  sendData(res, verification);
}

/** PATCH /api/v1/admin/verifications/:id/in-review */
export async function markInReview(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const verification = await verificationService.markInReview(requireUser(req).id, id);
  sendData(res, verification);
}

/** PATCH /api/v1/admin/verifications/:id/approve */
export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { note } = validatedBody<{ note?: string }>(req);
  const verification = await verificationService.approve(requireUser(req).id, id, note);
  sendData(res, verification);
}

/** PATCH /api/v1/admin/verifications/:id/reject */
export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { note } = validatedBody<AdminRejectBody>(req);
  const verification = await verificationService.reject(requireUser(req).id, id, note);
  sendData(res, verification);
}

/** PATCH /api/v1/admin/verifications/:id/request-info */
export async function requestInfo(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { note } = validatedBody<{ note: string }>(req);
  const verification = await verificationService.requestInfo(requireUser(req).id, id, note);
  sendData(res, verification);
}

/** POST /api/v1/admin/verifications/grandfather */
export async function grandfather(req: Request, res: Response): Promise<void> {
  const body = validatedBody<GrandfatherApprovalBody>(req);
  const verification = await verificationService.grandfatherApproval(
    requireUser(req).id,
    body.coachProfileId,
    body.note,
  );
  sendData(res, verification);
}

/**
 * GET /api/v1/admin/verifications/documents/:documentId/file
 *
 * Streams a private document to an authenticated administrator. The bytes are proxied by
 * the API on purpose: no public or long-lived object URL ever exists for these files, so a
 * leaked link cannot expose somebody's diploma.
 */
export async function downloadDocument(req: Request, res: Response): Promise<void> {
  const { documentId } = validatedParams<{ documentId: string }>(req);
  const document = await verificationService.getDocumentForAdmin(documentId);
  const bytes = await storageService.readPrivateObject(document.storageKey);

  const fileName = (document.originalFileName ?? `document.${document.contentType.split('/')[1] ?? 'bin'}`).replace(
    /["\r\n]/g,
    '',
  );

  res.setHeader('Content-Type', document.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(bytes);
}
