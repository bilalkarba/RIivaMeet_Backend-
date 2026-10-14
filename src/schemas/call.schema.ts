import { z } from 'zod';

import { limitQuery, pageQuery, uuidSchema } from './common.schema.js';

/**
 * Call signalling payloads.
 *
 * These validate the *shape* of a socket event. Authorization (is this user part of
 * the conversation / call?) is enforced by `call.service`, never here.
 */

export const CALL_TYPES = ['AUDIO', 'VIDEO'] as const;

/** `call:invite` - start a call in a booking conversation. */
export const inviteCallSchema = z
  .object({
    conversationId: uuidSchema,
    type: z.enum(CALL_TYPES),
  })
  .strict();

/** `call:accept` / `call:reject` / `call:end` - act on an existing call. */
export const callIdSchema = z.object({ callId: uuidSchema }).strict();

/**
 * `call:signal` - relay one SDP offer/answer or a batch of ICE candidates to the peer.
 *
 * The payload is opaque to the server (WebRTC owns its schema) but is bounded in size
 * so it cannot be used as a general-purpose message bus.
 */
const SIGNAL_MAX_BYTES = 64 * 1024;

export const callSignalSchema = z
  .object({
    callId: uuidSchema,
    /// Discriminator so the peer knows how to consume `data` (offer | answer | candidate).
    kind: z.enum(['offer', 'answer', 'candidate']),
    data: z.unknown(),
  })
  .strict()
  .superRefine((value, ctx) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value.data);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Signal payload is not serializable' });
      return;
    }
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > SIGNAL_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `Signal payload exceeds ${SIGNAL_MAX_BYTES} bytes` });
    }
  });

/** `GET /api/v1/conversations/:id/calls` */
export const listCallsQuerySchema = z.object({ page: pageQuery, limit: limitQuery }).strict();

export type InviteCallPayload = z.infer<typeof inviteCallSchema>;
export type CallIdPayload = z.infer<typeof callIdSchema>;
export type CallSignalPayload = z.infer<typeof callSignalSchema>;
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;
