import { z } from 'zod';

import { limitQuery, pageQuery, trimmedString } from './common.schema.js';

/**
 * Admin-only moderation queue filters.
 *
 * `reviewed` is a tri-state query parameter: `true` (already reviewed), `false`
 * (pending review) or omitted (everything). An empty value means "not provided".
 */
const reviewedQuery = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.enum(['true', 'false']).optional(),
);

export const adminListModerationFlagsQuerySchema = z
  .object({
    reviewed: reviewedQuery,
    page: pageQuery,
    limit: limitQuery,
  })
  .strict();

export const reviewModerationFlagBodySchema = z
  .object({
    note: trimmedString(3, 2000).optional(),
  })
  .strict();

export type AdminListModerationFlagsQuery = z.infer<typeof adminListModerationFlagsQuerySchema>;
export type ReviewModerationFlagBody = z.infer<typeof reviewModerationFlagBodySchema>;
