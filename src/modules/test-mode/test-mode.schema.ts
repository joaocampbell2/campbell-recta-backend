import { z } from 'zod';

export const startTestModeSchema = z.object({
  householdId: z.string().uuid().optional(),
});

export type StartTestModeInput = z.infer<typeof startTestModeSchema>;

export const applyTestModeSchema = z.object({
  sandboxHouseholdId: z.string().uuid(),
  originalHouseholdId: z.string().uuid().optional(),
  force: z.boolean().optional().default(false),
});

export type ApplyTestModeInput = z.infer<typeof applyTestModeSchema>;
