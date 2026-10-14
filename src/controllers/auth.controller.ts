import type { Request, Response } from 'express';

import type { LoginBody, RegisterBody } from '../schemas/auth.schema.js';
import * as authService from '../services/auth.service.js';
import { ApiError } from '../utils/errors.js';
import { sendCreated, sendData } from '../utils/http.js';
import { validatedBody } from '../middleware/validate.js';

/** POST /api/v1/auth/register */
export async function register(req: Request, res: Response): Promise<void> {
  const body = validatedBody<RegisterBody>(req);
  const result = await authService.registerUser(body);
  sendCreated(res, result);
}

/** POST /api/v1/auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  const body = validatedBody<LoginBody>(req);
  const result = await authService.loginUser(body);
  sendData(res, result);
}

/** GET /api/v1/auth/me */
export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  const user = await authService.getCurrentUser(req.user.id);
  sendData(res, { user });
}
