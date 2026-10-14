import type { Request, Response } from 'express';

import { checkDatabaseConnection } from '../config/prisma.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js';

/**
 * GET /health
 *
 * Used by Northflank (and Docker HEALTHCHECK) to decide whether the container is
 * ready to receive traffic. Returns 503 when the database is unreachable so the
 * platform can restart/replace the instance instead of serving broken responses.
 *
 * Deliberately unwrapped (not `{ data: ... }`) because infrastructure probes expect
 * a flat health document.
 */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let database: 'up' | 'down' = 'up';
  let databaseLatencyMs: number | null = null;

  try {
    await checkDatabaseConnection();
    databaseLatencyMs = Date.now() - startedAt;
  } catch {
    database = 'down';
  }

  const healthy = database === 'up';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
    timestamp: new Date().toISOString(),
    checks: {
      database,
      databaseLatencyMs,
    },
  });
}

/** GET / - tiny discovery document so the root path is not a 404. */
export function serviceInfo(_req: Request, res: Response): void {
  res.json({
    data: {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      api: '/api/v1',
      docs: '/docs',
      openapi: '/docs.json',
      health: '/health',
    },
  });
}
