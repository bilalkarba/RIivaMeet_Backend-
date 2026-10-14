import { z } from 'zod';

/** Request an upload target (presigned URL) for a new avatar or post media object. */
export const createUploadBodySchema = z
  .object({
    kind: z.enum(['avatar', 'post']).default('avatar'),
    contentType: z
      .string()
      .trim()
      .regex(/^[a-z]+\/[a-z0-9.+-]+$/i, 'contentType must be a valid MIME type, e.g. image/png'),
  })
  .strict();

export const localUploadQuerySchema = z.object({
  key: z.string().min(3).max(400),
  exp: z.coerce.number().int().positive(),
  token: z.string().min(16).max(256),
});

export type CreateUploadBody = z.infer<typeof createUploadBodySchema>;
export type LocalUploadQuery = z.infer<typeof localUploadQuerySchema>;
