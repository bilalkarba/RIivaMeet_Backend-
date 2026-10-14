import type { Request, Response } from 'express';

import { validatedBody, validatedParams } from '../middleware/validate.js';
import type {
  AddProfileSportBody,
  ReplaceProfileSportsBody,
  UpdateProfileBody,
} from '../schemas/profile.schema.js';
import * as profileService from '../services/profile.service.js';
import { ApiError } from '../utils/errors.js';
import { sendCreated, sendData } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/profile/me */
export async function getMyProfile(req: Request, res: Response): Promise<void> {
  const profile = await profileService.getSelfProfile(requireUserId(req));
  sendData(res, profile);
}

/** PATCH /api/v1/profile/me */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  const body = validatedBody<UpdateProfileBody>(req);
  const profile = await profileService.updateSelfProfile(requireUserId(req), body);
  sendData(res, profile);
}

/** GET /api/v1/profile/:userId */
export async function getProfile(req: Request, res: Response): Promise<void> {
  const { userId } = validatedParams<{ userId: string }>(req);
  const profile = await profileService.getPublicProfile(userId);
  sendData(res, profile);
}

/** GET /api/v1/profile/me/sports */
export async function listMySports(req: Request, res: Response): Promise<void> {
  const sports = await profileService.getMySports(requireUserId(req));
  sendData(res, sports);
}

/** PUT /api/v1/profile/me/sports */
export async function replaceMySports(req: Request, res: Response): Promise<void> {
  const body = validatedBody<ReplaceProfileSportsBody>(req);
  const sports = await profileService.replaceMySports(requireUserId(req), body);
  sendData(res, sports);
}

/** POST /api/v1/profile/me/sports */
export async function addMySport(req: Request, res: Response): Promise<void> {
  const body = validatedBody<AddProfileSportBody>(req);
  const sports = await profileService.addMySport(requireUserId(req), body);
  sendCreated(res, sports);
}

/** DELETE /api/v1/profile/me/sports/:sportId */
export async function removeMySport(req: Request, res: Response): Promise<void> {
  const { sportId } = validatedParams<{ sportId: string }>(req);
  const sports = await profileService.removeMySport(requireUserId(req), sportId);
  sendData(res, sports);
}
