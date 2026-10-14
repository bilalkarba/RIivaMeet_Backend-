import http from 'node:http';

import { createApp } from './app.js';
import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { checkDatabaseConnection, disconnectDatabase } from './config/prisma.js';
import { initRealtime } from './realtime/socket.js';

/**
 * Process entry point: starts the HTTP server and owns graceful shutdown.
 *
 * Shutdown order matters: stop accepting new connections, let in-flight requests
 * finish, then release database connections so the platform can replace the
 * container without dropping requests or leaking pool connections.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();
const server = http.createServer(app);
// Socket.IO shares the HTTP server (same port) and authenticates with the same JWT.
const realtime = initRealtime(server);
realtime.io.on('connection_error', (error) => logger.debug({ err: error }, 'socket connection rejected'));

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    { port: env.PORT, host: env.HOST, env: env.NODE_ENV, version: SERVICE_VERSION },
    `${SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}`,
  );

  // Verify connectivity once at boot. A failure is logged (not fatal) so the
  // health endpoint can report "degraded" while the platform restarts the task.
  checkDatabaseConnection()
    .then(() => logger.info('database connection established'))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'database connection failed at startup - /health will report degraded');
    });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, 'shutdown signal received - closing server');

  // Drop realtime connections first so `server.close` can finish promptly.
  // (`io.close()` would also close the HTTP server, so sockets are disconnected here
  // and the HTTP server shutdown below stays the single owner of that sequence.)
  realtime.io.disconnectSockets(true);

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out - forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'error while closing the HTTP server');
    }

    try {
      await disconnectDatabase();
      logger.info('database connections released - bye');
    } catch (disconnectError) {
      logger.error({ err: disconnectError }, 'error while disconnecting from the database');
    } finally {
      clearTimeout(forceExit);
      process.exit(error ? 1 : 0);
    }
  });

  // Stop keep-alive connections so `close` can finish promptly.
  server.closeIdleConnections();
}

process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});
process.on('SIGINT', (signal) => {
  void shutdown(signal);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception - exiting');
  void shutdown('SIGTERM');
});

export { app, server };
