import type { Request, Response } from 'express';

import { validatedBody, validatedQuery } from '../middleware/validate.js';
import type { CreateUploadBody, LocalUploadQuery } from '../schemas/storage.schema.js';
import {
  createUploadTarget,
  getStorageStatus,
  verifyLocalUploadToken,
  writeLocalObject,
} from '../services/storage.service.js';
import { ApiError } from '../utils/errors.js';
import { sendCreated, sendData } from '../utils/http.js';

/** GET /api/v1/storage/status */
export function getStatus(_req: Request, res: Response): void {
  sendData(res, getStorageStatus());
}

/** POST /api/v1/storage/uploads */
export async function createUpload(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  const body = validatedBody<CreateUploadBody>(req);
  const target = await createUploadTarget({
    kind: body.kind,
    ownerUserId: req.user.id,
    contentType: body.contentType,
  });
  sendCreated(res, target);
}

/**
 * PUT /api/v1/storage/local
 * Development/test only: receives raw bytes for the `local` storage provider.
 * In production every provider is S3-compatible and this route always answers 403.
 */
export async function localUpload(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<LocalUploadQuery>(req);
  if (!verifyLocalUploadToken(query.key, query.exp, query.token)) {
    throw ApiError.forbidden('Invalid or expired upload token');
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (body.byteLength === 0) {
    throw ApiError.badRequest('Empty upload body');
  }

  await writeLocalObject(query.key, body);
  sendData(res, { key: query.key, size: body.byteLength });
}
