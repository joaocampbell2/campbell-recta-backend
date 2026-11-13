import { z } from 'zod';

// ============================================================================
// Enums & Primitives
// ============================================================================

export const splitGroupCategoryEnum = z.enum(['trip', 'home', 'food', 'party', 'other']);
export type SplitGroupCategory = z.infer<typeof splitGroupCategoryEnum>;

export const splitDirectionEnum = z.enum(['THEY_OWE_ME', 'I_OWE_THEM']);
export type SplitDirection = z.infer<typeof splitDirectionEnum>;

export const splitRuleEnum = z.enum([
  'EQUAL',
  'PERCENTAGE',
  'UNEQUAL',
  'FIFTY_FIFTY',
  'FULL_AMOUNT',
  'EQUAL_GROUP',
  'CUSTOM',
]);
export type SplitRule = z.infer<typeof splitRuleEnum>;

// ============================================================================
// Common Query & Param Schemas
// ============================================================================

export const splitHouseholdQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
});
export type SplitHouseholdQuery = z.infer<typeof splitHouseholdQuerySchema>;

export const splitLegacyCandidatesQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  includeAll: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => val === true || val === 'true'),
});
export type SplitLegacyCandidatesQuery = z.infer<typeof splitLegacyCandidatesQuerySchema>;

export const idParamSchema = z.object({
  id: z.string().uuid(),
});
export type IdParam = z.infer<typeof idParamSchema>;

export const debtIdParamSchema = z.object({
  debtId: z.string().uuid(),
});
export type DebtIdParam = z.infer<typeof debtIdParamSchema>;

export const friendIdParamSchema = z.object({
  friendId: z.string().uuid(),
});
export type FriendIdParam = z.infer<typeof friendIdParamSchema>;

export const debtInstallmentParamsSchema = z.object({
  debtId: z.string().uuid(),
  installmentId: z.string().uuid(),
});
export type DebtInstallmentParams = z.infer<typeof debtInstallmentParamsSchema>;

// ============================================================================
// 2. Amigos (POST / PATCH / DELETE)
// ============================================================================

export const createSplitFriendSchema = z.object({
  householdId: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(150),
  emailOrPix: z.string().trim().max(255).optional().nullable(),
  avatarColor: z.string().trim().max(50).optional().default('bg-purple-500'),
  avatarUrl: z.string().optional().nullable(),
});
export type CreateSplitFriendInput = z.infer<typeof createSplitFriendSchema>;

export const archiveSplitEntitySchema = z.object({
  archived: z.boolean(),
});
export type ArchiveSplitEntityInput = z.infer<typeof archiveSplitEntitySchema>;

// ============================================================================
// 3. Grupos (POST / PATCH / DELETE)
// ============================================================================

export const createSplitGroupSchema = z.object({
  householdId: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(150),
  category: splitGroupCategoryEnum.optional().default('other'),
  memberIds: z.array(z.string()).optional().default([]),
  avatarUrl: z.string().optional().nullable(),
});
export type CreateSplitGroupInput = z.infer<typeof createSplitGroupSchema>;

// ============================================================================
// 4. Dívidas, Parcelas, Quitação e Migração
// ============================================================================

export const createSplitDebtShareSchema = z.object({
  friendId: z.string().uuid(),
  debtTotalAmount: z.coerce.number().positive('Share amount must be positive'),
});

export const createSplitDebtsSchema = z.object({
  householdId: z.string().uuid().optional(),
  description: z.string().trim().min(1, 'Description is required'),
  category: z.string().max(100).optional().nullable(),
  accountId: z.string().optional().nullable(),
  accountName: z.string().max(150).optional().nullable(),
  originalTotalAmount: z.coerce.number().positive('Total amount must be positive'),
  direction: splitDirectionEnum,
  payerFriendId: z.string().optional().nullable(),
  splitRule: splitRuleEnum,
  groupId: z.string().optional().nullable(),
  totalInstallments: z.coerce.number().int().min(1).max(120).optional().default(1),
  shares: z.array(createSplitDebtShareSchema).min(1, 'At least one share is required'),
});
export type CreateSplitDebtsInput = z.infer<typeof createSplitDebtsSchema>;

export const toggleSplitInstallmentSchema = z.object({
  paid: z.boolean(),
  paidAt: z.string().optional().nullable(),
  paidNote: z.string().optional().nullable(),
});
export type ToggleSplitInstallmentInput = z.infer<typeof toggleSplitInstallmentSchema>;

export const settleSplitDebtSchema = z.object({
  mode: z.enum(['full', 'partial']),
  paidAmount: z.coerce.number().nonnegative('Paid amount must be non-negative'),
  forgiveRemainder: z.boolean().optional().default(false),
});
export type SettleSplitDebtInput = z.infer<typeof settleSplitDebtSchema>;

export const settleFriendMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format'),
});
export type SettleFriendMonthInput = z.infer<typeof settleFriendMonthSchema>;

export const legacyReimbursementEntrySchema = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.coerce.number().positive(),
  date: z.string(),
});

export const legacyImportItemSchema = z.object({
  transactionId: z.string(),
  reimbursementTransactionId: z.string().optional().nullable(),
  reimbursementTransactionIds: z.array(z.string()).optional().nullable(),
  reimbursements: z.array(legacyReimbursementEntrySchema).optional().nullable(),
  friendId: z.string().uuid(),
  description: z.string().trim().min(1),
  amount: z.coerce.number().positive(),
  date: z.string(),
  accountId: z.string().optional().nullable(),
  accountName: z.string().optional().nullable(),
  paid: z.boolean(),
  paidAmount: z.coerce.number().nonnegative().optional().nullable(),
  paidAt: z.string().optional().nullable(),
  forgiveRemainder: z.boolean().optional().default(false),
});
export type LegacyImportItemInput = z.infer<typeof legacyImportItemSchema>;

export const importLegacySplitDebtsSchema = z.object({
  householdId: z.string().uuid().optional(),
  deleteOriginalTransactions: z.boolean().optional().default(false),
  items: z.array(legacyImportItemSchema).min(1, 'At least one item is required'),
});
export type ImportLegacySplitDebtsInput = z.infer<typeof importLegacySplitDebtsSchema>;
