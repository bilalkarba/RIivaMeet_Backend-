import { pino, type Logger } from 'pino';

import { env } from './env.js';

/**
 * Structured application logger.
 *
 * Pretty, human-readable output in development; newline-delimited JSON (what log
 * aggregators expect) everywhere else. Authorization headers and cookies are
 * redacted so tokens never end up in logs.
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'password_hash',
  'token',
];

export const logger: Logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'coachini-api', env: env.NODE_ENV },
  redact: { paths: redactPaths, censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : {}),
});
