import { z } from 'zod';

export const startTestModeSchema = z.object({
  householdId: z.string().uuid().optional(),
});

export type StartTestModeInput = z.infer<typeof startTestModeSchema>;
