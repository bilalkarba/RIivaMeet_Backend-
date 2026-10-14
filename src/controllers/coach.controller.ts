import type { Request, Response } from 'express';

import { validatedBody, validatedParams, validatedQuery } from '../middleware/validate.js';
import type {
  CreateAvailabilityBody,
  CreateCoachProfileBody,
  SearchCoachesQuery,
  UpdateCoachProfileBody,
} from '../schemas/coach.schema.js';
import { getRelatedUserIds } from '../services/block.service.js';
import * as coachService from '../services/coach.service.js';
import { ApiError } from '../utils/errors.js';
import { buildPaginationMeta, sendCreated, sendData, sendPaginated } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/coaches */
export async function searchCoaches(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<SearchCoachesQuery>(req);
  // Signed-in callers never see coaches they blocked (or who blocked them).
  const excludeUserIds = req.user ? await getRelatedUserIds(req.user.id) : [];
  const { coaches, total } = await coachService.searchCoaches(query, { excludeUserIds });
  sendPaginated(res, coaches, buildPaginationMeta(query.page, query.limit, total));
}

/** GET /api/v1/coaches/:id */
export async function getCoach(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const coach = await coachService.getCoachById(id);
  sendData(res, coach);
}

/** GET /api/v1/coaches/me/profile */
export async function getMyProfile(req: Request, res: Response): Promise<void> {
  const coach = await coachService.getMyCoachProfile(requireUserId(req));
  sendData(res, coach);
}

/** POST /api/v1/coaches/me/profile */
export async function createMyProfile(req: Request, res: Response): Promise<void> {
  const body = validatedBody<CreateCoachProfileBody>(req);
  const coach = await coachService.createCoachProfile(requireUserId(req), body);
  sendCreated(res, coach);
}

/** PATCH /api/v1/coaches/me/profile */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  const body = validatedBody<UpdateCoachProfileBody>(req);
  const coach = await coachService.updateCoachProfile(requireUserId(req), body);
  sendData(res, coach);
}

/** GET /api/v1/coaches/me/sports */
export async function listMySports(req: Request, res: Response): Promise<void> {
  const sports = await coachService.listMySports(requireUserId(req));
  sendData(res, sports);
}

/** PUT /api/v1/coaches/me/sports */
export async function replaceMySports(req: Request, res: Response): Promise<void> {
  const body = validatedBody<{ sportIds?: string[]; sportSlugs?: string[] }>(req);
  const sports = await coachService.replaceMySports(requireUserId(req), body);
  sendData(res, sports);
}

/** POST /api/v1/coaches/me/sports */
export async function addMySport(req: Request, res: Response): Promise<void> {
  const body = validatedBody<{ sportId: string }>(req);
  const sports = await coachService.addMySport(requireUserId(req), body);
  sendCreated(res, sports);
}

/** DELETE /api/v1/coaches/me/sports/:sportId */
export async function removeMySport(req: Request, res: Response): Promise<void> {
  const { sportId } = validatedParams<{ sportId: string }>(req);
  const sports = await coachService.removeMySport(requireUserId(req), sportId);
  sendData(res, sports);
}

/** GET /api/v1/coaches/me/availability */
export async function listMyAvailability(req: Request, res: Response): Promise<void> {
  const slots = await coachService.listMyAvailability(requireUserId(req));
  sendData(res, slots);
}

/** POST /api/v1/coaches/me/availability */
export async function createMyAvailability(req: Request, res: Response): Promise<void> {
  const body = validatedBody<CreateAvailabilityBody>(req);
  const slots = await coachService.createMyAvailability(requireUserId(req), body);
  sendCreated(res, slots);
}

/** DELETE /api/v1/coaches/me/availability/:availabilityId */
export async function deleteMyAvailability(req: Request, res: Response): Promise<void> {
  const { availabilityId } = validatedParams<{ availabilityId: string }>(req);
  const slots = await coachService.deleteMyAvailability(requireUserId(req), availabilityId);
  sendData(res, slots);
}
