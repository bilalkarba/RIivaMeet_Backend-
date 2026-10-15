
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import * as helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

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
 * RIivaMeet Express application factory.
 *
 * The server and Socket.IO lifecycle remain managed by server.ts.
 */
export function createApp(): Express {
  const app = express();

  // Security and reverse-proxy configuration.
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('json escape', true);

  // Request logging and observability.
  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) =>
        (req as express.Request).requestId ?? randomUUID(),
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' || req.url === '/',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req, res) =>
        `${req.method} ${req.url} -> ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} -> ${res.statusCode}: ${err.message}`,
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
    }),
  );

  // Security headers.
  app.use(
    helmet.default({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS configuration.
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      if (
        !origin ||
        env.corsOrigins.includes('*') ||
        env.corsOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(
        ApiError.forbidden(`Origin ${origin} is not allowed by CORS`),
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  };

  app.use(cors(corsOptions));

  // Request parsing.
  app.use(express.json({ limit: '100kb' }));

  // Rate limiting.
  app.use(globalRateLimiter);

  // Local media is available only in non-production environments.
  if (storageConfig.provider === 'local' && !env.isProduction) {
    app.use(
      '/media',
      express.static(
        path.resolve(storageConfig.localDir ?? '.tmp/uploads'),
        { fallthrough: true },
      ),
    );
  }

  // Application routes.
  app.get('/', serviceInfo);
  app.use('/health', healthRoutes);
  app.use(API_PREFIX, apiRoutes);

  // Swagger documentation.
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
      customSiteTitle: 'RIivaMeet API docs',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
      },
    }),
  );

  app.get('/docs.json', (_req, res) => {
    res.json(openapiSpec);
  });

  // Error handling must remain last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
