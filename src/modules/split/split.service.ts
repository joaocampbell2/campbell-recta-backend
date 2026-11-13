import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import {
  CATEGORY_NAME_DISPLAY,
  CategoryName,
  TransactionType,
} from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { deleteTransaction } from '../transactions/transactions.service.js';
import type {
  CreateSplitFriendInput,
  CreateSplitGroupInput,
  CreateSplitDebtsInput,
  ToggleSplitInstallmentInput,
  SettleSplitDebtInput,
  ImportLegacySplitDebtsInput,
} from './split.schema.js';

const LEGACY_DEBTS_CUSTOM_CATEGORY = 'CUSTOM:23aabe0f-3545-432b-b8dc-5fb73fcd119c';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value?: string | null): value is string {
  return Boolean(value && UUID_REGEX.test(value));
}

function formatDateOnly(date: Date | string): string {
  if (typeof date === 'string') {
    const match = date.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function parseDateOnly(dateStr?: string | null): Date {
  if (!dateStr) {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10);
    return new Date(`${ymd}T12:00:00.000Z`);
  }
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return new Date(`${match[1]}T12:00:00.000Z`);
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    const ymd = parsed.toISOString().slice(0, 10);
    return new Date(`${ymd}T12:00:00.000Z`);
  }
  const fallback = new Date().toISOString().slice(0, 10);
  return new Date(`${fallback}T12:00:00.000Z`);
}

function addMonthsUTC(baseDate: Date, monthsToAdd: number): Date {
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth();
  const day = baseDate.getUTCDate();

  const targetMonthDate = new Date(Date.UTC(year, month + monthsToAdd, 1, 12, 0, 0));
  const maxDaysInTargetMonth = new Date(
    Date.UTC(targetMonthDate.getUTCFullYear(), targetMonthDate.getUTCMonth() + 1, 0)
  ).getUTCDate();

  targetMonthDate.setUTCDate(Math.min(day, maxDaysInTargetMonth));
  return targetMonthDate;
}

const DEBT_INCLUDE = {
  installments: {
    orderBy: { installmentNumber: 'asc' as const },
  },
  account: {
    select: { id: true, name: true },
  },
};

type SplitDebtWithRelations = Prisma.SplitDebtGetPayload<{
  include: typeof DEBT_INCLUDE;
}>;

type SplitGroupWithMembers = Prisma.SplitGroupGetPayload<{
  include: { members: true };
}>;

type SplitFriendRecord = Prisma.SplitFriendGetPayload<Record<string, never>>;

function serializeFriend(friend: SplitFriendRecord) {
  return {
    id: friend.id,
    name: friend.name,
    ...(friend.emailOrPix ? { emailOrPix: friend.emailOrPix } : {}),
    avatarColor: friend.avatarColor,
    ...(friend.avatarUrl ? { avatarUrl: friend.avatarUrl } : {}),
    archived: friend.archived,
  };
}

function serializeGroup(group: SplitGroupWithMembers) {
  return {
    id: group.id,
    name: group.name,
    category: group.category,
    memberIds: group.members.map((m) => m.friendId),
    ...(group.avatarUrl ? { avatarUrl: group.avatarUrl } : {}),
    archived: group.archived,
  };
}

function serializeDebt(debt: SplitDebtWithRelations) {
  const resolvedAccountName = debt.account?.name || debt.accountName || undefined;
  const forgivenNum =
    debt.forgivenAmount !== null && debt.forgivenAmount !== undefined
      ? debt.forgivenAmount.toNumber()
      : undefined;

  return {
    id: debt.id,
    description: debt.description,
    ...(debt.category ? { category: debt.category } : {}),
    ...(debt.accountId ? { accountId: debt.accountId } : {}),
    ...(resolvedAccountName ? { accountName: resolvedAccountName } : {}),
    originalTotalAmount: debt.originalTotalAmount.toNumber(),
    debtTotalAmount: debt.debtTotalAmount.toNumber(),
    direction: debt.direction as 'THEY_OWE_ME' | 'I_OWE_THEM',
    ...(debt.payerFriendId ? { payerFriendId: debt.payerFriendId } : {}),
    splitRule: debt.splitRule,
    friendId: debt.friendId,
    ...(debt.groupId ? { groupId: debt.groupId } : {}),
    createdAt: formatDateOnly(debt.createdAt),
    totalInstallments: debt.totalInstallments,
    ...(forgivenNum !== undefined && forgivenNum > 0 ? { forgivenAmount: forgivenNum } : {}),
    installments: debt.installments.map((inst) => ({
      id: inst.id,
      installmentNumber: inst.installmentNumber,
      totalInstallments: inst.totalInstallments,
      amount: inst.amount.toNumber(),
      dueDate: formatDateOnly(inst.dueDate),
      paid: inst.paid,
      ...(inst.paidAt ? { paidAt: formatDateOnly(inst.paidAt) } : {}),
      ...(inst.paidNote ? { paidNote: inst.paidNote } : {}),
    })),
  };
}

// ============================================================================
// 1 & 2. Amigos (GET / POST / PATCH / DELETE)
// ============================================================================

export async function listSplitFriends(householdId: string) {
  const friends = await prisma.splitFriend.findMany({
    where: { householdId },
    orderBy: { createdAt: 'asc' },
  });

  return friends.map(serializeFriend);
}

export async function findSplitFriendById(id: string) {
  return prisma.splitFriend.findUnique({
    where: { id },
  });
}

export async function createSplitFriend(
  householdId: string,
  input: CreateSplitFriendInput
) {
  const friend = await prisma.splitFriend.create({
    data: {
      householdId,
      name: input.name.trim(),
      emailOrPix: input.emailOrPix?.trim() || null,
      avatarColor: input.avatarColor || 'bg-purple-500',
      avatarUrl: input.avatarUrl || null,
      archived: false,
    },
  });

  return serializeFriend(friend);
}

export async function archiveSplitFriend(
  id: string,
  householdId: string,
  archived: boolean
) {
  const existing = await prisma.splitFriend.findFirst({
    where: { id, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split friend');
  }

  const updated = await prisma.splitFriend.update({
    where: { id },
    data: { archived },
  });

  return serializeFriend(updated);
}

export async function deleteSplitFriend(id: string, householdId: string) {
  const existing = await prisma.splitFriend.findFirst({
    where: { id, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split friend');
  }

  await prisma.splitFriend.delete({
    where: { id },
  });

  return { id };
}

// ============================================================================
// 1 & 3. Grupos (GET / POST / PATCH / DELETE)
// ============================================================================

export async function listSplitGroups(householdId: string) {
  const groups = await prisma.splitGroup.findMany({
    where: { householdId },
    include: {
      members: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return groups.map(serializeGroup);
}

export async function findSplitGroupById(id: string) {
  return prisma.splitGroup.findUnique({
    where: { id },
  });
}

export async function createSplitGroup(
  householdId: string,
  input: CreateSplitGroupInput
) {
  const candidateIds = Array.from(
    new Set((input.memberIds || []).filter((id): id is string => isUuid(id)))
  );

  const validFriends =
    candidateIds.length > 0
      ? await prisma.splitFriend.findMany({
          where: {
            householdId,
            id: { in: candidateIds },
          },
          select: { id: true },
        })
      : [];

  const validFriendIds = validFriends.map((f) => f.id);

  const group = await prisma.splitGroup.create({
    data: {
      householdId,
      name: input.name.trim(),
      category: input.category || 'other',
      avatarUrl: input.avatarUrl || null,
      archived: false,
      ...(validFriendIds.length > 0 && {
        members: {
          create: validFriendIds.map((friendId) => ({ friendId })),
        },
      }),
    },
    include: {
      members: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return serializeGroup(group);
}

export async function archiveSplitGroup(
  id: string,
  householdId: string,
  archived: boolean
) {
  const existing = await prisma.splitGroup.findFirst({
    where: { id, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split group');
  }

  const updated = await prisma.splitGroup.update({
    where: { id },
    data: { archived },
    include: {
      members: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return serializeGroup(updated);
}

export async function deleteSplitGroup(id: string, householdId: string) {
  const existing = await prisma.splitGroup.findFirst({
    where: { id, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split group');
  }

  await prisma.splitGroup.delete({
    where: { id },
  });

  return { id };
}

// ============================================================================
// 1 & 4. Dívidas, Parcelas, Quitação e Migração
// ============================================================================

export async function listSplitDebts(householdId: string) {
  const debts = await prisma.splitDebt.findMany({
    where: { householdId },
    include: DEBT_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  return debts.map(serializeDebt);
}

export async function findSplitDebtById(debtId: string) {
  return prisma.splitDebt.findUnique({
    where: { id: debtId },
  });
}

async function resolveValidAccount(
  householdId: string,
  accountId?: string | null,
  accountName?: string | null
): Promise<{ accountId: string | null; accountName: string | null }> {
  if (isUuid(accountId)) {
    const acc = await prisma.account.findFirst({
      where: { id: accountId },
      select: { id: true, name: true, householdId: true },
    });
    if (acc) {
      return {
        accountId: acc.id,
        accountName: accountName || acc.name,
      };
    }
  }
  return {
    accountId: null,
    accountName: accountName || null,
  };
}

async function resolveValidGroupId(
  householdId: string,
  groupId?: string | null
): Promise<string | null> {
  if (!isUuid(groupId)) return null;
  const grp = await prisma.splitGroup.findFirst({
    where: { id: groupId, householdId },
    select: { id: true },
  });
  return grp ? grp.id : null;
}

export async function createSplitDebts(
  householdId: string,
  input: CreateSplitDebtsInput
) {
  const count = Math.max(1, input.totalInstallments || 1);
  const baseDate = parseDateOnly();

  const { accountId: resolvedAccountId, accountName: resolvedAccountName } =
    await resolveValidAccount(householdId, input.accountId, input.accountName);
  const resolvedGroupId = await resolveValidGroupId(householdId, input.groupId);

  let resolvedPayerFriendId: string | null = null;
  if (isUuid(input.payerFriendId)) {
    const payer = await prisma.splitFriend.findFirst({
      where: { id: input.payerFriendId, householdId },
      select: { id: true },
    });
    if (payer) {
      resolvedPayerFriendId = payer.id;
    }
  }

  const friendIdsInShares = Array.from(new Set(input.shares.map((s) => s.friendId)));
  const existingFriends = await prisma.splitFriend.findMany({
    where: {
      householdId,
      id: { in: friendIdsInShares },
    },
    select: { id: true },
  });
  const validFriendSet = new Set(existingFriends.map((f) => f.id));

  for (const fId of friendIdsInShares) {
    if (!validFriendSet.has(fId)) {
      throw new BadRequestError(`Friend ${fId} does not belong to this household`);
    }
  }

  const createdDebts = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const results: SplitDebtWithRelations[] = [];

    for (const share of input.shares) {
      const perPersonTotal = Number(share.debtTotalAmount.toFixed(2));
      if (perPersonTotal <= 0) continue;

      const baseInstallmentAmount = Math.floor((perPersonTotal / count) * 100) / 100;
      const installmentsData = Array.from({ length: count }, (_, idx) => {
        const amount =
          idx === count - 1
            ? Number((perPersonTotal - baseInstallmentAmount * (count - 1)).toFixed(2))
            : baseInstallmentAmount;
        return {
          installmentNumber: idx + 1,
          totalInstallments: count,
          amount: new Prisma.Decimal(amount),
          dueDate: addMonthsUTC(baseDate, idx),
          paid: false,
        };
      });

      const targetFriendId =
        input.direction === 'I_OWE_THEM' && resolvedPayerFriendId
          ? resolvedPayerFriendId
          : share.friendId;

      const debt = await tx.splitDebt.create({
        data: {
          householdId,
          description: input.description.trim(),
          category: input.category || null,
          accountId: resolvedAccountId,
          accountName: resolvedAccountName,
          originalTotalAmount: new Prisma.Decimal(input.originalTotalAmount),
          debtTotalAmount: new Prisma.Decimal(perPersonTotal),
          direction: input.direction,
          payerFriendId:
            input.direction === 'I_OWE_THEM'
              ? resolvedPayerFriendId || share.friendId
              : resolvedPayerFriendId,
          splitRule: input.splitRule,
          friendId: targetFriendId,
          groupId: resolvedGroupId,
          totalInstallments: count,
          installments: {
            create: installmentsData,
          },
        },
        include: DEBT_INCLUDE,
      });

      results.push(debt);
    }

    return results;
  });

  return createdDebts.map(serializeDebt);
}

export async function toggleSplitInstallment(
  debtId: string,
  installmentId: string,
  householdId: string,
  input: ToggleSplitInstallmentInput
) {
  const debt = await prisma.splitDebt.findFirst({
    where: { id: debtId, householdId },
    include: { installments: true },
  });

  if (!debt) {
    throw new NotFoundError('Split debt');
  }

  const installment = debt.installments.find((i) => i.id === installmentId);
  if (!installment) {
    throw new NotFoundError('Split installment');
  }

  await prisma.splitInstallment.update({
    where: { id: installmentId },
    data: {
      paid: input.paid,
      paidAt: input.paid ? parseDateOnly(input.paidAt) : null,
      paidNote: input.paid ? input.paidNote || 'Marcado como pago' : null,
    },
  });

  const updatedDebt = await prisma.splitDebt.findUniqueOrThrow({
    where: { id: debtId },
    include: DEBT_INCLUDE,
  });

  return serializeDebt(updatedDebt);
}

export async function settleSplitDebt(
  debtId: string,
  householdId: string,
  input: SettleSplitDebtInput
) {
  const debt = await prisma.splitDebt.findFirst({
    where: { id: debtId, householdId },
    include: {
      installments: {
        orderBy: { installmentNumber: 'asc' },
      },
    },
  });

  if (!debt) {
    throw new NotFoundError('Split debt');
  }

  const today = parseDateOnly();

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (input.mode === 'full') {
      await tx.splitInstallment.updateMany({
        where: { debtId, paid: false },
        data: {
          paid: true,
          paidAt: today,
          paidNote: 'Quitado integralmente',
        },
      });
      return;
    }

    const alreadyPaid = debt.installments.filter((i) => i.paid);
    const unpaid = debt.installments.filter((i) => !i.paid);
    const remainingSum = unpaid.reduce((sum, inst) => sum + inst.amount.toNumber(), 0);
    const paidAmount = Number(input.paidAmount.toFixed(2));
    const remainder = Math.max(0, Number((remainingSum - paidAmount).toFixed(2)));

    if (input.forgiveRemainder) {
      const nextTotalCount = alreadyPaid.length + 1;

      // Remove unpaid installments
      if (unpaid.length > 0) {
        await tx.splitInstallment.deleteMany({
          where: { id: { in: unpaid.map((u) => u.id) } },
        });
      }

      // Re-number already paid installments and update totalInstallments
      for (let idx = 0; idx < alreadyPaid.length; idx++) {
        await tx.splitInstallment.update({
          where: { id: alreadyPaid[idx].id },
          data: {
            installmentNumber: idx + 1,
            totalInstallments: nextTotalCount,
          },
        });
      }

      // Create the partial paid installment
      await tx.splitInstallment.create({
        data: {
          debtId,
          installmentNumber: nextTotalCount,
          totalInstallments: nextTotalCount,
          amount: new Prisma.Decimal(paidAmount),
          dueDate: today,
          paid: true,
          paidAt: today,
          paidNote: 'Pagamento parcial (restante abonado)',
        },
      });

      const currentForgiven = debt.forgivenAmount ? debt.forgivenAmount.toNumber() : 0;
      const nextForgiven = Number((currentForgiven + remainder).toFixed(2));

      await tx.splitDebt.update({
        where: { id: debtId },
        data: {
          totalInstallments: nextTotalCount,
          forgivenAmount: new Prisma.Decimal(nextForgiven),
        },
      });
    } else {
      const unpaidCount = Math.max(1, unpaid.length);
      const nextTotalCount = alreadyPaid.length + 1 + unpaidCount;

      // Update alreadyPaid numbering
      for (let idx = 0; idx < alreadyPaid.length; idx++) {
        await tx.splitInstallment.update({
          where: { id: alreadyPaid[idx].id },
          data: {
            installmentNumber: idx + 1,
            totalInstallments: nextTotalCount,
          },
        });
      }

      // Create the partial paid installment right after alreadyPaid
      await tx.splitInstallment.create({
        data: {
          debtId,
          installmentNumber: alreadyPaid.length + 1,
          totalInstallments: nextTotalCount,
          amount: new Prisma.Decimal(paidAmount),
          dueDate: today,
          paid: true,
          paidAt: today,
          paidNote: 'Pagamento parcial',
        },
      });

      // Redistribute remainder across unpaid installments
      const baseUnpaid = Math.floor((remainder / unpaidCount) * 100) / 100;
      if (unpaid.length > 0) {
        for (let idx = 0; idx < unpaid.length; idx++) {
          const amt =
            idx === unpaidCount - 1
              ? Number((remainder - baseUnpaid * (unpaidCount - 1)).toFixed(2))
              : baseUnpaid;
          await tx.splitInstallment.update({
            where: { id: unpaid[idx].id },
            data: {
              installmentNumber: alreadyPaid.length + 2 + idx,
              totalInstallments: nextTotalCount,
              amount: new Prisma.Decimal(amt),
            },
          });
        }
      } else {
        await tx.splitInstallment.create({
          data: {
            debtId,
            installmentNumber: alreadyPaid.length + 2,
            totalInstallments: nextTotalCount,
            amount: new Prisma.Decimal(remainder),
            dueDate: today,
            paid: false,
          },
        });
      }

      await tx.splitDebt.update({
        where: { id: debtId },
        data: {
          totalInstallments: nextTotalCount,
        },
      });
    }
  });

  const updatedDebt = await prisma.splitDebt.findUniqueOrThrow({
    where: { id: debtId },
    include: DEBT_INCLUDE,
  });

  return serializeDebt(updatedDebt);
}

export async function settleFriendMonth(
  friendId: string,
  householdId: string,
  month: string
) {
  const friend = await prisma.splitFriend.findFirst({
    where: { id: friendId, householdId },
  });
  if (!friend) {
    throw new NotFoundError('Split friend');
  }

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIdx = Number(monthStr) - 1;
  const startOfMonth = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999));
  const today = parseDateOnly();

  await prisma.splitInstallment.updateMany({
    where: {
      paid: false,
      dueDate: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
      debt: {
        householdId,
        friendId,
      },
    },
    data: {
      paid: true,
      paidAt: today,
      paidNote: 'Parcela do mês quitada',
    },
  });

  const updatedDebts = await prisma.splitDebt.findMany({
    where: { householdId, friendId },
    include: DEBT_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  return updatedDebts.map(serializeDebt);
}

export async function deleteSplitDebt(debtId: string, householdId: string) {
  const existing = await prisma.splitDebt.findFirst({
    where: { id: debtId, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split debt');
  }

  await prisma.splitDebt.delete({
    where: { id: debtId },
  });

  return { id: debtId };
}

// ============================================================================
// Legacy Candidates & Legacy Import
// ============================================================================

export async function getSplitLegacyCandidates(
  householdId: string,
  includeAll: boolean
) {
  const [customCategories, importedDebts, importedInstallments, transactions] =
    await Promise.all([
      prisma.category.findMany({
        where: { householdId },
        select: { id: true, name: true },
      }),
      prisma.splitDebt.findMany({
        where: {
          householdId,
          legacyTransactionId: { not: null },
        },
        select: { legacyTransactionId: true },
      }),
      prisma.splitInstallment.findMany({
        where: {
          legacyReimbursementTxId: { not: null },
          debt: { householdId },
        },
        select: { legacyReimbursementTxId: true },
      }),
      prisma.transaction.findMany({
        where: {
          householdId,
          type: { in: [TransactionType.INCOME, TransactionType.EXPENSE] },
        },
        include: {
          account: {
            select: { id: true, name: true },
          },
        },
        orderBy: { date: 'desc' },
      }),
    ]);

  const customCatMap = new Map<string, string>(
    customCategories.map((c) => [c.id, c.name])
  );

  const alreadyImportedIds = new Set<string>();
  for (const d of importedDebts) {
    if (d.legacyTransactionId) alreadyImportedIds.add(d.legacyTransactionId);
  }
  for (const i of importedInstallments) {
    if (i.legacyReimbursementTxId) alreadyImportedIds.add(i.legacyReimbursementTxId);
  }

  function resolveCategoryLabel(categoryName?: string | null): string {
    if (!categoryName) return '';
    if (categoryName === LEGACY_DEBTS_CUSTOM_CATEGORY) {
      const fromDb = toCustomCategoryId(categoryName);
      return (fromDb && customCatMap.get(fromDb)) || 'Dívidas';
    }
    if (isCustomCategoryName(categoryName)) {
      const id = toCustomCategoryId(categoryName);
      return (id && customCatMap.get(id)) || categoryName;
    }
    return CATEGORY_NAME_DISPLAY[categoryName as CategoryName] || categoryName;
  }

  const debts: Array<{
    id: string;
    description: string;
    amount: number;
    date: string;
    category: string;
    categoryName?: string;
    type: 'INCOME' | 'EXPENSE';
    accountId?: string;
    accountName?: string;
  }> = [];

  const reimbursements: Array<{
    id: string;
    description: string;
    amount: number;
    date: string;
    category: string;
    categoryName?: string;
    type: 'INCOME' | 'EXPENSE';
    accountId?: string;
    accountName?: string;
  }> = [];

  for (const tx of transactions) {
    if (alreadyImportedIds.has(tx.id)) continue;

    const categoryLabel = resolveCategoryLabel(tx.categoryName);
    const catLower = categoryLabel.toLowerCase();
    const descLower = (tx.description || '').toLowerCase();
    const txType: 'INCOME' | 'EXPENSE' =
      tx.type === TransactionType.INCOME ? 'INCOME' : 'EXPENSE';

    const mapped = {
      id: tx.id,
      description: tx.description || categoryLabel || 'Transação',
      amount: tx.amount.toNumber(),
      date: formatDateOnly(tx.date),
      category: categoryLabel,
      ...(tx.categoryName ? { categoryName: tx.categoryName } : {}),
      type: txType,
      ...(tx.accountId ? { accountId: tx.accountId } : {}),
      ...(tx.account?.name ? { accountName: tx.account.name } : {}),
    };

    const isReimbursementKeyword =
      catLower.includes('reembolso') || descLower.includes('reembolso');
    const isDebtKeyword =
      tx.categoryName === LEGACY_DEBTS_CUSTOM_CATEGORY ||
      catLower.includes('dívida') ||
      catLower.includes('divida') ||
      catLower.includes('empréstimo') ||
      catLower.includes('emprestimo') ||
      descLower.includes('dívida') ||
      descLower.includes('divida') ||
      descLower.includes('empréstimo') ||
      descLower.includes('emprestimo');

    if (txType === 'INCOME' || isReimbursementKeyword) {
      if (
        includeAll ||
        isReimbursementKeyword ||
        isDebtKeyword ||
        txType === 'INCOME'
      ) {
        reimbursements.push(mapped);
      }
      continue;
    }

    if (txType === 'EXPENSE') {
      if (includeAll || isDebtKeyword) {
        debts.push(mapped);
      }
    }
  }

  return {
    debts,
    reimbursements,
  };
}

export async function importLegacySplitDebts(
  householdId: string,
  input: ImportLegacySplitDebtsInput
) {
  const friendIds = Array.from(new Set(input.items.map((i) => i.friendId)));
  const existingFriends = await prisma.splitFriend.findMany({
    where: {
      householdId,
      id: { in: friendIds },
    },
    select: { id: true },
  });
  const validFriendSet = new Set(existingFriends.map((f) => f.id));

  for (const fId of friendIds) {
    if (!validFriendSet.has(fId)) {
      throw new BadRequestError(`Friend ${fId} does not belong to this household`);
    }
  }

  const createdDebts: SplitDebtWithRelations[] = [];

  for (const item of input.items) {
    const { accountId: resolvedAccountId, accountName: resolvedAccountName } =
      await resolveValidAccount(householdId, item.accountId, item.accountName);

    const itemAmount = Number(item.amount.toFixed(2));
    const paidAmt =
      item.paid && item.paidAmount !== undefined && item.paidAmount !== null
        ? Number(item.paidAmount.toFixed(2))
        : itemAmount;
    const isPartial = item.paid && paidAmt < itemAmount - 0.01;
    const remainder = isPartial ? Number((itemAmount - paidAmt).toFixed(2)) : 0;
    const debtDate = parseDateOnly(item.date);

    const paidInstallmentsFromReimbs =
      item.reimbursements && item.reimbursements.length > 0
        ? item.reimbursements.map((r, rIdx) => ({
            installmentNumber: rIdx + 1,
            amount: new Prisma.Decimal(Number(r.amount.toFixed(2))),
            dueDate: debtDate,
            paid: true,
            paidAt: parseDateOnly(r.date),
            paidNote: r.description || 'Reembolso importado',
            legacyReimbursementTxId: isUuid(r.id) ? r.id : null,
          }))
        : [
            {
              installmentNumber: 1,
              amount: new Prisma.Decimal(paidAmt),
              dueDate: debtDate,
              paid: true,
              paidAt: parseDateOnly(item.paidAt || item.date),
              paidNote: 'Reembolso importado',
              legacyReimbursementTxId: isUuid(item.reimbursementTransactionId)
                ? item.reimbursementTransactionId
                : null,
            },
          ];

    let rawInstallments: Array<{
      installmentNumber: number;
      amount: Prisma.Decimal;
      dueDate: Date;
      paid: boolean;
      paidAt?: Date | null;
      paidNote?: string | null;
      legacyReimbursementTxId?: string | null;
    }>;
    let forgivenAmountDecimal: Prisma.Decimal | null = null;

    if (isPartial && item.forgiveRemainder) {
      forgivenAmountDecimal = new Prisma.Decimal(remainder);
      rawInstallments = paidInstallmentsFromReimbs;
    } else if (isPartial && !item.forgiveRemainder) {
      rawInstallments = [
        ...paidInstallmentsFromReimbs,
        {
          installmentNumber: paidInstallmentsFromReimbs.length + 1,
          amount: new Prisma.Decimal(remainder),
          dueDate: debtDate,
          paid: false,
          paidAt: null,
          paidNote: null,
          legacyReimbursementTxId: null,
        },
      ];
    } else if (item.paid) {
      rawInstallments = paidInstallmentsFromReimbs;
    } else {
      rawInstallments = [
        {
          installmentNumber: 1,
          amount: new Prisma.Decimal(itemAmount),
          dueDate: debtDate,
          paid: false,
          paidAt: null,
          paidNote: null,
          legacyReimbursementTxId: null,
        },
      ];
    }

    const totalInstallmentsCount = rawInstallments.length;

    const debt = await prisma.splitDebt.create({
      data: {
        householdId,
        description: item.description.trim(),
        category: LEGACY_DEBTS_CUSTOM_CATEGORY,
        accountId: resolvedAccountId,
        accountName: resolvedAccountName,
        originalTotalAmount: new Prisma.Decimal(itemAmount),
        debtTotalAmount: new Prisma.Decimal(itemAmount),
        forgivenAmount: forgivenAmountDecimal,
        direction: 'THEY_OWE_ME',
        splitRule: 'FULL_AMOUNT',
        friendId: item.friendId,
        totalInstallments: totalInstallmentsCount,
        legacyTransactionId: isUuid(item.transactionId) ? item.transactionId : null,
        createdAt: debtDate,
        installments: {
          create: rawInstallments.map((inst, idx) => ({
            installmentNumber: idx + 1,
            totalInstallments: totalInstallmentsCount,
            amount: inst.amount,
            dueDate: inst.dueDate,
            paid: inst.paid,
            paidAt: inst.paidAt ?? null,
            paidNote: inst.paidNote ?? null,
            legacyReimbursementTxId: inst.legacyReimbursementTxId ?? null,
          })),
        },
      },
      include: DEBT_INCLUDE,
    });

    createdDebts.push(debt);
  }

  if (input.deleteOriginalTransactions) {
    const txIdsToDelete = new Set<string>();
    for (const item of input.items) {
      if (isUuid(item.transactionId)) {
        txIdsToDelete.add(item.transactionId);
      }
      if (isUuid(item.reimbursementTransactionId)) {
        txIdsToDelete.add(item.reimbursementTransactionId);
      }
      for (const rId of item.reimbursementTransactionIds || []) {
        if (isUuid(rId)) txIdsToDelete.add(rId);
      }
      for (const r of item.reimbursements || []) {
        if (isUuid(r.id)) txIdsToDelete.add(r.id);
      }
    }

    for (const txId of txIdsToDelete) {
      try {
        await deleteTransaction(txId, householdId);
      } catch {
        // Ignore if already deleted by client or not found
      }
    }
  }

  return createdDebts.map(serializeDebt);
}
