import { z } from 'zod';

export const listSportsQuerySchema = z.object({}).strict();

export type ListSportsQuery = z.infer<typeof listSportsQuerySchema>;
