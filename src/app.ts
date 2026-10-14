import { randomUUID } from 'node:crypto';

import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import path from 'node:path';

import { API_PREFIX } from './config/constants.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { storageConfig } from './config/storage.js';
import { openapiSpec } from './config/swagger.js';
import { serviceInfo } from './controllers/health.controller.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';
import { ApiError } from './utils/errors.js';

/**
 * Express application factory.
 *
 * Exported as a factory (rather than a module-level singleton) so tests can build
 * isolated instances without opening a TCP port; `server.ts` owns the listening
 * socket and the shutdown sequence.
 */
export function createApp(): Express {
  const app = express();

  // Do not advertise the framework.
  app.disable('x-powered-by');
  // Correct client IPs behind the Northflank load balancer (needed by rate limiting).
  app.set('trust proxy', env.TRUST_PROXY);
  // Escape <, > and & in JSON responses to blunt XSS when payloads are embedded in HTML.
  app.set('json escape', true);

  // --- Observability ------------------------------------------------------
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? randomUUID(),
      autoLogging: {
        // Probes and the discovery document would otherwise flood the logs.
        ignore: (req) => req.url === '/health' || req.url === '/',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
      customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode}: ${err.message}`,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // --- Security -----------------------------------------------------------
  // CSP is disabled globally (this is a JSON API) and re-enabled for /docs below.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // No Origin header: server-to-server, curl, Postman, mobile apps.
      if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  };
  app.use(cors(corsOptions));

  // --- Parsing ------------------------------------------------------------
  app.use(express.json({ limit: '100kb' }));

  // --- Rate limiting ------------------------------------------------------
  app.use(globalRateLimiter);

  // --- Dev-only media serving (STORAGE_PROVIDER=local) --------------------
  // Production uses an S3-compatible bucket and never serves user media itself.
  if (storageConfig.provider === 'local' && !env.isProduction) {
    app.use('/media', express.static(path.resolve(storageConfig.localDir ?? '.tmp/uploads'), { fallthrough: true }));
  }

  // --- Routes -------------------------------------------------------------
  app.get('/', serviceInfo);
  app.use('/health', healthRoutes);
  app.use(API_PREFIX, apiRoutes);

  // --- API documentation --------------------------------------------------
  const docsCsp = helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
    },
  });
  app.use(
    '/docs',
    docsCsp,
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'Coachini API docs',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
    }),
  );
  app.get('/docs.json', (_req, res) => {
    res.json(openapiSpec);
  });

  // --- Terminal middleware ------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
