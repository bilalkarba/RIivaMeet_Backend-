/** Shared constants used by the health endpoint, Swagger and 404 messages. */
export const SERVICE_NAME = 'coachini-api';
export const SERVICE_VERSION = process.env.SERVICE_VERSION ?? '1.0.0';
export const API_PREFIX = '/api/v1';
/** Default page size for every list endpoint. */
export const DEFAULT_PAGE_SIZE = 20;
