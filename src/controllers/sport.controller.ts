import type { Request, Response } from 'express';

import * as sportService from '../services/sport.service.js';
import { sendData } from '../utils/http.js';

/** GET /api/v1/sports */
export async function listSports(_req: Request, res: Response): Promise<void> {
  const sports = await sportService.listSports();
  sendData(res, sports);
}
