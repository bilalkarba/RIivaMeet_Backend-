import type { Request, Response } from 'express';

import * as notificationService from '../services/notification.service.js';
import { ApiError } from '../utils/errors.js';
import { sendData } from '../utils/http.js';

function requireUserId(req: Request): string {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user.id;
}

/** GET /api/v1/notifications/mine */
export async function listMyNotifications(req: Request, res: Response): Promise<void> {
  const inbox = await notificationService.listMyNotifications(requireUserId(req));
  sendData(res, inbox);
}

/** PATCH /api/v1/notifications/mine/read */
export async function markMyNotificationsRead(req: Request, res: Response): Promise<void> {
  const result = await notificationService.markMyNotificationsRead(requireUserId(req));
  sendData(res, result);
}
