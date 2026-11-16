import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import {
  AccountType,
  CATEGORY_NAME_DISPLAY,
  CategoryName,
  CategoryType,
  TransactionType,
} from '../../shared/enums/index.js';
import {
  isCustomCategoryName,
  toCustomCategoryId,
  toCustomCategoryName,
} from '../../shared/utils/categoryHelpers.js';
import {
  updateBalanceForNormalTransaction,
  recalculateCreditCardLimit,
} from '../../shared/services/balance.service.js';
import type {
  CreateSplitFriendInput,
  UpdateSplitFriendInput,
  CreateSplitGroupInput,
  CreateSplitDebtsInput,
  ToggleSplitInstallmentInput,
  SettleSplitDebtInput,
  LinkReimbursementInput,
  SettleFriendInput,
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

function calculateBalanceChange(
  amount: number,
  isIncome: boolean,
  accountType: string
): number {
  const absAmount = Math.abs(amount);
  if (accountType === AccountType.CREDIT) {
    return isIncome ? -absAmount : absAmount;
  }
  return isIncome ? absAmount : -absAmount;
}

async function resolveOrCreateCustomCategory(
  tx: Prisma.TransactionClient,
  householdId: string,
  keywords: string[],
  defaultName: string,
  type: CategoryType,
  icon: string,
  color: string
): Promise<string> {
  const existing = await tx.category.findMany({
    where: { householdId, type },
    select: { id: true, name: true },
  });

  const matched = existing.find((cat) => {
    const lower = cat.name.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  });

  if (matched) {
    return toCustomCategoryName(matched.id);
  }

  const created = await tx.category.create({
    data: {
      householdId,
      name: defaultName,
      type,
      icon,
      color,
    },
    select: { id: true },
  });

  return toCustomCategoryName(created.id);
}

async function resolveAccountForSplit(
  tx: Prisma.TransactionClient,
  householdId: string,
  accountId?: string | null
) {
  if (isUuid(accountId)) {
    const acc = await tx.account.findFirst({
      where: { id: accountId, isActive: true },
      select: { id: true, name: true, type: true, closingDay: true },
    });
    if (acc) return acc;
  }
  const fallback = await tx.account.findFirst({
    where: { householdId, isActive: true, type: { not: AccountType.CREDIT } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, type: true, closingDay: true },
  });
  return fallback;
}

interface LinkedTxSeriesParams {
  householdId: string;
  type: TransactionType.INCOME | TransactionType.EXPENSE;
  accountId: string | null;
  accountType?: string | null;
  closingDay?: number | null;
  categoryName: string;
  totalAmount: number;
  description: string;
  baseDate: Date;
  totalInstallments: number;
  paid: boolean;
  splitDebtId?: string | null;
  splitSettlementId?: string | null;
  notes?: string | null;
}

async function createLinkedTransactionsInTx(
  tx: Prisma.TransactionClient,
  params: LinkedTxSeriesParams
): Promise<string[]> {
  const count = Math.max(1, params.totalInstallments || 1);
  const total = Number(params.totalAmount.toFixed(2));
  if (total <= 0) return [];

  const isCreditCardInstallment =
    params.accountType === AccountType.CREDIT && count > 1;

  const installmentId = count > 1 ? randomUUID() : null;
  const baseAmt = Math.floor((total / count) * 100) / 100;
  const createdIds: string[] = [];
  let totalPaidBalanceChange = 0;

  for (let idx = 0; idx < count; idx++) {
    const amount =
      idx === count - 1
        ? Number((total - baseAmt * (count - 1)).toFixed(2))
        : baseAmt;
    const txDate = addMonthsUTC(params.baseDate, idx);
    const isPaid = isCreditCardInstallment ? true : params.paid;

    const created = await tx.transaction.create({
      data: {
        householdId: params.householdId,
        type: params.type,
        accountId: params.accountId,
        categoryName: params.categoryName,
        amount: new Prisma.Decimal(amount),
        description: params.description,
        date: txDate,
        notes: params.notes || null,
        paid: isPaid,
        ...(installmentId ? { installmentId } : {}),
        ...(count > 1
          ? { installmentNumber: idx + 1, totalInstallments: count }
          : {}),
        ...(params.splitDebtId ? { splitDebtId: params.splitDebtId } : {}),
        ...(params.splitSettlementId
          ? { splitSettlementId: params.splitSettlementId }
          : {}),
      },
      select: { id: true },
    });

    createdIds.push(created.id);

    if (isPaid && params.accountId && params.accountType) {
      totalPaidBalanceChange += calculateBalanceChange(
        amount,
        params.type === TransactionType.INCOME,
        params.accountType
      );
    }
  }

  if (
    Math.abs(totalPaidBalanceChange) > 0.001 &&
    params.accountId &&
    params.accountType
  ) {
    await updateBalanceForNormalTransaction(
      tx,
      params.accountId,
      totalPaidBalanceChange
    );
    if (params.accountType === AccountType.CREDIT) {
      await recalculateCreditCardLimit(tx, params.accountId);
    }
  }

  return createdIds;
}

async function revertAndDeleteTransactionsInTx(
  tx: Prisma.TransactionClient,
  where: Prisma.TransactionWhereInput
): Promise<number> {
  const transactions = await tx.transaction.findMany({
    where,
    include: {
      account: {
        select: { id: true, type: true },
      },
    },
  });

  if (transactions.length === 0) return 0;

  const balanceReversals = new Map<string, { change: number; type: string }>();

  for (const t of transactions) {
    const wasPaid = t.paid !== false;
    if (wasPaid && t.accountId && t.account && t.categoryName) {
      const isInc = t.type === TransactionType.INCOME;
      const reverseChange = -calculateBalanceChange(
        t.amount.toNumber(),
        isInc,
        t.account.type
      );
      const current = balanceReversals.get(t.accountId);
      balanceReversals.set(t.accountId, {
        change: (current?.change || 0) + reverseChange,
        type: t.account.type,
      });
    }
  }

  const deleted = await tx.transaction.deleteMany({
    where: { id: { in: transactions.map((t) => t.id) } },
  });

  for (const [accountId, info] of balanceReversals.entries()) {
    if (Math.abs(info.change) > 0.001) {
      await updateBalanceForNormalTransaction(tx, accountId, info.change);
      if (info.type === AccountType.CREDIT) {
        await recalculateCreditCardLimit(tx, accountId);
      }
    }
  }

  return deleted.count;
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

export async function updateSplitFriend(
  id: string,
  householdId: string,
  input: UpdateSplitFriendInput
) {
  const existing = await prisma.splitFriend.findFirst({
    where: { id, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split friend');
  }

  const updated = await prisma.splitFriend.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.emailOrPix !== undefined && {
        emailOrPix: input.emailOrPix?.trim() || null,
      }),
      ...(input.avatarColor !== undefined && { avatarColor: input.avatarColor }),
      ...(input.avatarUrl !== undefined && {
        avatarUrl: input.avatarUrl?.trim() || null,
      }),
    },
  });

  return serializeFriend(updated);
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

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const debts = await tx.splitDebt.findMany({
      where: { householdId, friendId: id },
      select: { id: true },
    });
    const settlements = await tx.splitSettlement.findMany({
      where: { householdId, friendId: id },
      select: { id: true },
    });

    const debtIds = debts.map((d) => d.id);
    const settlementIds = settlements.map((s) => s.id);

    if (debtIds.length > 0 || settlementIds.length > 0) {
      await revertAndDeleteTransactionsInTx(tx, {
        householdId,
        OR: [
          ...(debtIds.length > 0 ? [{ splitDebtId: { in: debtIds } }] : []),
          ...(settlementIds.length > 0
            ? [{ splitSettlementId: { in: settlementIds } }]
            : []),
        ],
      });
    }

    await tx.splitFriend.delete({
      where: { id },
    });
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
  const baseDate = parseDateOnly(input.date);

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
    select: { id: true, name: true },
  });
  const friendNameMap = new Map(existingFriends.map((f) => [f.id, f.name]));

  for (const fId of friendIdsInShares) {
    if (!friendNameMap.has(fId)) {
      throw new BadRequestError(`Friend ${fId} does not belong to this household`);
    }
  }

  const createdDebts = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const results: SplitDebtWithRelations[] = [];
    const alreadyPaid = Boolean(input.alreadyPaid);
    const markInitialPaid = input.direction === 'I_OWE_THEM' && alreadyPaid;

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
          paid: markInitialPaid,
          ...(markInitialPaid
            ? { paidAt: baseDate, paidNote: 'Já pago no lançamento' }
            : {}),
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
          accountId:
            input.direction === 'I_OWE_THEM' && !alreadyPaid
              ? null
              : resolvedAccountId,
          accountName:
            input.direction === 'I_OWE_THEM' && !alreadyPaid
              ? null
              : resolvedAccountName,
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
          createdAt: baseDate,
          totalInstallments: count,
          installments: {
            create: installmentsData,
          },
        },
        include: DEBT_INCLUDE,
      });

      results.push(debt);
    }

    if (input.createTransactions !== false && results.length > 0) {
      const account = resolvedAccountId
        ? await tx.account.findFirst({
            where: { id: resolvedAccountId, isActive: true },
            select: { id: true, type: true, closingDay: true },
          })
        : null;

      const myCategory = input.category || CategoryName.OTHER_EXPENSES;

      if (input.direction === 'THEY_OWE_ME') {
        const sharesSum = results.reduce(
          (acc, d) => acc + d.debtTotalAmount.toNumber(),
          0
        );
        const computedMyShare =
          input.myShareAmount !== undefined && input.myShareAmount !== null
            ? Number(input.myShareAmount.toFixed(2))
            : Number(Math.max(0, input.originalTotalAmount - sharesSum).toFixed(2));

        // 1. Minha parte na categoria escolhida
        if (computedMyShare > 0) {
          await createLinkedTransactionsInTx(tx, {
            householdId,
            type: TransactionType.EXPENSE,
            accountId: account?.id || null,
            accountType: account?.type || null,
            closingDay: account?.closingDay ?? null,
            categoryName: myCategory,
            totalAmount: computedMyShare,
            description: input.description.trim(),
            baseDate,
            totalInstallments: count,
            paid: count === 1,
            splitDebtId: results[0].id,
          });
        }

        // 2. 1 transação (ou série) por amigo na categoria Dívidas
        const debtsCategory = await resolveOrCreateCustomCategory(
          tx,
          householdId,
          ['dívida', 'divida'],
          'Dívidas',
          CategoryType.EXPENSE,
          '🤝',
          '#8B5CF6'
        );

        for (const debt of results) {
          const friendName = friendNameMap.get(debt.friendId);
          await createLinkedTransactionsInTx(tx, {
            householdId,
            type: TransactionType.EXPENSE,
            accountId: account?.id || null,
            accountType: account?.type || null,
            closingDay: account?.closingDay ?? null,
            categoryName: debtsCategory,
            totalAmount: debt.debtTotalAmount.toNumber(),
            description: `${input.description.trim()}${
              friendName ? ` (${friendName})` : ''
            }`,
            baseDate,
            totalInstallments: count,
            paid: count === 1,
            splitDebtId: debt.id,
          });
        }
      } else {
        // I_OWE_THEM: 1 transação (ou série) da minha parte na categoria escolhida
        const myDebt = results[0];
        await createLinkedTransactionsInTx(tx, {
          householdId,
          type: TransactionType.EXPENSE,
          accountId: alreadyPaid ? account?.id || null : null,
          accountType: alreadyPaid ? account?.type || null : null,
          closingDay: alreadyPaid ? account?.closingDay ?? null : null,
          categoryName: myCategory,
          totalAmount: myDebt.debtTotalAmount.toNumber(),
          description: input.description.trim(),
          baseDate,
          totalInstallments: count,
          paid: alreadyPaid,
          splitDebtId: myDebt.id,
        });
      }
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
      friend: { select: { id: true, name: true } },
      installments: {
        orderBy: { installmentNumber: 'asc' },
      },
    },
  });

  if (!debt) {
    throw new NotFoundError('Split debt');
  }

  let existingTx: {
    id: string;
    date: Date;
    amount: Prisma.Decimal;
    accountId: string | null;
    splitDebtId: string | null;
    splitSettlementId: string | null;
  } | null = null;

  if (input.existingTransactionId) {
    existingTx = await prisma.transaction.findFirst({
      where: { id: input.existingTransactionId, householdId },
      select: {
        id: true,
        date: true,
        amount: true,
        accountId: true,
        splitDebtId: true,
        splitSettlementId: true,
      },
    });
    if (!existingTx) {
      throw new NotFoundError('Transaction');
    }
    if (existingTx.splitDebtId || existingTx.splitSettlementId) {
      throw new BadRequestError(
        'Esta transação já está vinculada a uma dívida ou acerto.'
      );
    }
  }

  const today = parseDateOnly();
  const settlementDate = existingTx ? existingTx.date : today;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const unpaid = debt.installments.filter((i) => !i.paid);
    const remainingSum = Number(
      unpaid.reduce((sum, inst) => sum + inst.amount.toNumber(), 0).toFixed(2)
    );
    const paidAmount =
      input.mode === 'full'
        ? remainingSum
        : Number(input.paidAmount.toFixed(2));
    const explicitForgive =
      input.mode === 'partial' &&
      paidAmount === 0 &&
      input.forgiveAmount !== undefined &&
      input.forgiveAmount > 0
        ? Number(Math.min(remainingSum, input.forgiveAmount).toFixed(2))
        : null;
    const remainder =
      input.mode === 'full'
        ? 0
        : explicitForgive !== null
        ? Math.max(0, Number((remainingSum - explicitForgive).toFixed(2)))
        : Math.max(0, Number((remainingSum - paidAmount).toFixed(2)));
    const forgivenDelta =
      explicitForgive !== null
        ? explicitForgive
        : input.mode === 'partial' && input.forgiveRemainder
        ? remainder
        : 0;

    if (input.mode === 'full') {
      await tx.splitInstallment.updateMany({
        where: { debtId, paid: false },
        data: {
          paid: true,
          paidAt: settlementDate,
          paidNote: existingTx ? 'Reembolso vinculado' : 'Quitado integralmente',
        },
      });
    } else {
      const alreadyPaid = debt.installments.filter((i) => i.paid);

      if (explicitForgive !== null && remainder > 0.009) {
        const unpaidCount = Math.max(1, unpaid.length);
        const baseUnpaid = Math.floor((remainder / unpaidCount) * 100) / 100;
        for (let idx = 0; idx < unpaid.length; idx++) {
          const amt =
            idx === unpaidCount - 1
              ? Number((remainder - baseUnpaid * (unpaidCount - 1)).toFixed(2))
              : baseUnpaid;
          await tx.splitInstallment.update({
            where: { id: unpaid[idx].id },
            data: { amount: new Prisma.Decimal(amt) },
          });
        }

        const currentForgiven = debt.forgivenAmount ? debt.forgivenAmount.toNumber() : 0;
        await tx.splitDebt.update({
          where: { id: debtId },
          data: {
            forgivenAmount: new Prisma.Decimal(
              Number((currentForgiven + explicitForgive).toFixed(2))
            ),
          },
        });
      } else if (input.forgiveRemainder || (explicitForgive !== null && remainder <= 0.009)) {
        const shouldCreateZeroInst = paidAmount === 0 && alreadyPaid.length === 0;
        const nextTotalCount =
          paidAmount > 0
            ? alreadyPaid.length + 1
            : Math.max(1, alreadyPaid.length);

        if (unpaid.length > 0) {
          await tx.splitInstallment.deleteMany({
            where: { id: { in: unpaid.map((u) => u.id) } },
          });
        }

        for (let idx = 0; idx < alreadyPaid.length; idx++) {
          await tx.splitInstallment.update({
            where: { id: alreadyPaid[idx].id },
            data: {
              installmentNumber: idx + 1,
              totalInstallments: nextTotalCount,
            },
          });
        }

        if (paidAmount > 0 || shouldCreateZeroInst) {
          await tx.splitInstallment.create({
            data: {
              debtId,
              installmentNumber: nextTotalCount,
              totalInstallments: nextTotalCount,
              amount: new Prisma.Decimal(paidAmount),
              dueDate: settlementDate,
              paid: true,
              paidAt: settlementDate,
              paidNote:
                paidAmount === 0
                  ? 'Dívida abonada integralmente'
                  : existingTx
                  ? 'Reembolso vinculado (restante abonado)'
                  : 'Pagamento parcial (restante abonado)',
            },
          });
        }

        const currentForgiven = debt.forgivenAmount ? debt.forgivenAmount.toNumber() : 0;
        const nextForgiven = Number((currentForgiven + forgivenDelta).toFixed(2));

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

        for (let idx = 0; idx < alreadyPaid.length; idx++) {
          await tx.splitInstallment.update({
            where: { id: alreadyPaid[idx].id },
            data: {
              installmentNumber: idx + 1,
              totalInstallments: nextTotalCount,
            },
          });
        }

        await tx.splitInstallment.create({
          data: {
            debtId,
            installmentNumber: alreadyPaid.length + 1,
            totalInstallments: nextTotalCount,
            amount: new Prisma.Decimal(paidAmount),
            dueDate: settlementDate,
            paid: true,
            paidAt: settlementDate,
            paidNote: existingTx ? 'Reembolso vinculado' : 'Pagamento parcial',
          },
        });

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
    }

    // Se I_OWE_THEM e quitou totalmente (ou abonou), marca transações pendentes vinculadas como paid: true
    if (
      debt.direction === 'I_OWE_THEM' &&
      (input.mode === 'full' || input.forgiveRemainder)
    ) {
      await tx.transaction.updateMany({
        where: { splitDebtId: debtId, householdId, paid: false },
        data: { paid: true },
      });
    }

    // Cria SplitSettlement e transações vinculadas se houver valor pago ou abonado
    const account = await resolveAccountForSplit(
      tx,
      householdId,
      existingTx?.accountId || input.accountId || debt.accountId
    );
    const shouldCreateAbono =
      forgivenDelta > 0 && debt.direction === 'THEY_OWE_ME';

    if (paidAmount > 0 || shouldCreateAbono) {
      const settlement = await tx.splitSettlement.create({
        data: {
          householdId,
          friendId: debt.friendId,
          direction:
            debt.direction === 'THEY_OWE_ME' ? 'THEY_PAID_ME' : 'I_PAID_THEM',
          totalPaid: new Prisma.Decimal(paidAmount),
          forgivenAmount: shouldCreateAbono ? new Prisma.Decimal(forgivenDelta) : null,
          accountId: account?.id || null,
          settledAt: settlementDate,
          notes: existingTx
            ? `Reembolso vinculado: ${debt.description}`
            : `Acerto: ${debt.description}`,
          items: {
            create: [
              {
                debtId,
                amountApplied: new Prisma.Decimal(paidAmount),
              },
            ],
          },
        },
      });

      let settlementTxId: string | null = null;
      let abonoTxId: string | null = null;

      if (paidAmount > 0) {
        if (existingTx) {
          await tx.transaction.update({
            where: { id: existingTx.id },
            data: { splitSettlementId: settlement.id },
          });
          settlementTxId = existingTx.id;
        } else if (debt.direction === 'THEY_OWE_ME') {
          const reimbCategory = await resolveOrCreateCustomCategory(
            tx,
            householdId,
            ['reembolso'],
            'Reembolso',
            CategoryType.INCOME,
            '💸',
            '#10B981'
          );
          const createdIds = await createLinkedTransactionsInTx(tx, {
            householdId,
            type: TransactionType.INCOME,
            accountId: account?.id || null,
            accountType: account?.type || null,
            closingDay: account?.closingDay ?? null,
            categoryName: reimbCategory,
            totalAmount: paidAmount,
            description: `Reembolso: ${debt.description} (${debt.friend.name})`,
            baseDate: today,
            totalInstallments: 1,
            paid: true,
            splitSettlementId: settlement.id,
          });
          settlementTxId = createdIds[0] || null;
        } else if (account) {
          const paymentCategory =
            debt.category ||
            (await resolveOrCreateCustomCategory(
              tx,
              householdId,
              ['dívida', 'divida'],
              'Dívidas',
              CategoryType.EXPENSE,
              '🤝',
              '#8B5CF6'
            ));
          const createdIds = await createLinkedTransactionsInTx(tx, {
            householdId,
            type: TransactionType.EXPENSE,
            accountId: account.id,
            accountType: account.type,
            closingDay: account.closingDay ?? null,
            categoryName: paymentCategory,
            totalAmount: paidAmount,
            description: `Pagamento: ${debt.description} (${debt.friend.name})`,
            baseDate: today,
            totalInstallments: 1,
            paid: true,
            splitSettlementId: settlement.id,
          });
          settlementTxId = createdIds[0] || null;
        }
      }

      if (settlementTxId) {
        await tx.splitSettlement.update({
          where: { id: settlement.id },
          data: { settlementTransactionId: settlementTxId },
        });
      }
    }
  });

  const updatedDebt = await prisma.splitDebt.findUniqueOrThrow({
    where: { id: debtId },
    include: DEBT_INCLUDE,
  });

  return serializeDebt(updatedDebt);
}

export async function linkReimbursementToDebts(
  householdId: string,
  input: LinkReimbursementInput
) {
  const existingTx = await prisma.transaction.findFirst({
    where: { id: input.existingTransactionId, householdId },
    select: {
      id: true,
      date: true,
      amount: true,
      accountId: true,
      splitDebtId: true,
      splitSettlementId: true,
    },
  });

  if (!existingTx) {
    throw new NotFoundError('Transaction');
  }
  if (existingTx.splitDebtId || existingTx.splitSettlementId) {
    throw new BadRequestError(
      'Esta transação já está vinculada a uma dívida ou acerto.'
    );
  }

  const uniqueDebtIds = Array.from(new Set(input.debtIds));
  const debts = await prisma.splitDebt.findMany({
    where: {
      id: { in: uniqueDebtIds },
      householdId,
    },
    include: {
      friend: { select: { id: true, name: true } },
      installments: { orderBy: { installmentNumber: 'asc' } },
    },
  });

  if (debts.length !== uniqueDebtIds.length) {
    throw new NotFoundError('Split debt');
  }

  const debtMap = new Map(debts.map((d) => [d.id, d]));
  const orderedDebts = uniqueDebtIds.map((id) => debtMap.get(id)!);
  const settlementDate = existingTx.date;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let remainingReimbursement = Number(existingTx.amount.toNumber().toFixed(2));
    const appliedByFriend = new Map<
      string,
      {
        friendId: string;
        friendName: string;
        totalApplied: number;
        forgivenAmount: number;
        descriptions: string[];
        items: Array<{ debtId: string; amountApplied: number }>;
      }
    >();

    for (const debt of orderedDebts) {
      if (remainingReimbursement <= 0.009) break;
      if (debt.direction !== 'THEY_OWE_ME') {
        throw new BadRequestError(
          `A dívida "${debt.description}" não é do tipo a receber.`
        );
      }

      const unpaid = debt.installments.filter((i) => !i.paid);
      const debtRemaining = Number(
        unpaid.reduce((s, inst) => s + inst.amount.toNumber(), 0).toFixed(2)
      );
      if (debtRemaining <= 0.009) continue;

      const amountToApply = Number(
        Math.min(debtRemaining, remainingReimbursement).toFixed(2)
      );
      const remainder = Math.max(
        0,
        Number((debtRemaining - amountToApply).toFixed(2))
      );
      const isFullForDebt = remainder <= 0.009;

      if (isFullForDebt) {
        await tx.splitInstallment.updateMany({
          where: { debtId: debt.id, paid: false },
          data: {
            paid: true,
            paidAt: settlementDate,
            paidNote: 'Reembolso vinculado',
          },
        });
      } else {
        const alreadyPaid = debt.installments.filter((i) => i.paid);
        if (input.forgiveRemainder) {
          const nextTotalCount = alreadyPaid.length + 1;
          if (unpaid.length > 0) {
            await tx.splitInstallment.deleteMany({
              where: { id: { in: unpaid.map((u) => u.id) } },
            });
          }
          for (let idx = 0; idx < alreadyPaid.length; idx++) {
            await tx.splitInstallment.update({
              where: { id: alreadyPaid[idx].id },
              data: {
                installmentNumber: idx + 1,
                totalInstallments: nextTotalCount,
              },
            });
          }
          await tx.splitInstallment.create({
            data: {
              debtId: debt.id,
              installmentNumber: nextTotalCount,
              totalInstallments: nextTotalCount,
              amount: new Prisma.Decimal(amountToApply),
              dueDate: settlementDate,
              paid: true,
              paidAt: settlementDate,
              paidNote: 'Reembolso vinculado (restante abonado)',
            },
          });

          const currentForgiven = debt.forgivenAmount
            ? debt.forgivenAmount.toNumber()
            : 0;
          await tx.splitDebt.update({
            where: { id: debt.id },
            data: {
              totalInstallments: nextTotalCount,
              forgivenAmount: new Prisma.Decimal(
                Number((currentForgiven + remainder).toFixed(2))
              ),
            },
          });
        } else {
          const unpaidCount = Math.max(1, unpaid.length);
          const nextTotalCount = alreadyPaid.length + 1 + unpaidCount;
          for (let idx = 0; idx < alreadyPaid.length; idx++) {
            await tx.splitInstallment.update({
              where: { id: alreadyPaid[idx].id },
              data: {
                installmentNumber: idx + 1,
                totalInstallments: nextTotalCount,
              },
            });
          }
          await tx.splitInstallment.create({
            data: {
              debtId: debt.id,
              installmentNumber: alreadyPaid.length + 1,
              totalInstallments: nextTotalCount,
              amount: new Prisma.Decimal(amountToApply),
              dueDate: settlementDate,
              paid: true,
              paidAt: settlementDate,
              paidNote: 'Reembolso vinculado',
            },
          });
          const baseUnpaid = Math.floor((remainder / unpaidCount) * 100) / 100;
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
          await tx.splitDebt.update({
            where: { id: debt.id },
            data: { totalInstallments: nextTotalCount },
          });
        }
      }

      remainingReimbursement = Number(
        (remainingReimbursement - amountToApply).toFixed(2)
      );

      const entry = appliedByFriend.get(debt.friendId) || {
        friendId: debt.friendId,
        friendName: debt.friend.name,
        totalApplied: 0,
        forgivenAmount: 0,
        descriptions: [],
        items: [],
      };
      entry.totalApplied = Number((entry.totalApplied + amountToApply).toFixed(2));
      if (!isFullForDebt && input.forgiveRemainder) {
        entry.forgivenAmount = Number((entry.forgivenAmount + remainder).toFixed(2));
      }
      entry.descriptions.push(debt.description);
      entry.items.push({ debtId: debt.id, amountApplied: amountToApply });
      appliedByFriend.set(debt.friendId, entry);
    }

    if (appliedByFriend.size === 0) {
      throw new BadRequestError('Nenhuma dívida em aberto selecionada.');
    }

    const account = await resolveAccountForSplit(
      tx,
      householdId,
      existingTx.accountId
    );
    let firstSettlementId: string | null = null;

    for (const group of appliedByFriend.values()) {
      const settlement = await tx.splitSettlement.create({
        data: {
          householdId,
          friendId: group.friendId,
          direction: 'THEY_PAID_ME',
          totalPaid: new Prisma.Decimal(group.totalApplied),
          forgivenAmount:
            group.forgivenAmount > 0
              ? new Prisma.Decimal(group.forgivenAmount)
              : null,
          accountId: account?.id || null,
          settlementTransactionId: existingTx.id,
          settledAt: settlementDate,
          notes: `Reembolso vinculado: ${group.descriptions.join(', ')}`,
          items: {
            create: group.items.map((it) => ({
              debtId: it.debtId,
              amountApplied: new Prisma.Decimal(it.amountApplied),
            })),
          },
        },
      });

      if (!firstSettlementId) {
        firstSettlementId = settlement.id;
      }
    }

    if (firstSettlementId) {
      await tx.transaction.update({
        where: { id: existingTx.id },
        data: { splitSettlementId: firstSettlementId },
      });
    }
  });

  const updatedDebts = await prisma.splitDebt.findMany({
    where: { id: { in: uniqueDebtIds }, householdId },
    include: DEBT_INCLUDE,
  });

  return updatedDebts.map(serializeDebt);
}

interface FifoInstallmentEntry {
  id: string;
  debtId: string;
  installmentNumber: number;
  totalInstallments: number;
  amount: number;
  dueDate: Date;
}

async function applyFifoInstallmentsInTx(
  tx: Prisma.TransactionClient,
  entries: FifoInstallmentEntry[],
  amountToApply: number,
  today: Date,
  paidNote: string
): Promise<Array<{ debtId: string; installmentId: string; amountApplied: number }>> {
  let remaining = Number(amountToApply.toFixed(2));
  const appliedItems: Array<{
    debtId: string;
    installmentId: string;
    amountApplied: number;
  }> = [];

  for (const entry of entries) {
    if (remaining <= 0.005) break;

    if (remaining >= entry.amount - 0.005) {
      await tx.splitInstallment.update({
        where: { id: entry.id },
        data: {
          paid: true,
          paidAt: today,
          paidNote,
        },
      });
      appliedItems.push({
        debtId: entry.debtId,
        installmentId: entry.id,
        amountApplied: entry.amount,
      });
      remaining = Number(Math.max(0, remaining - entry.amount).toFixed(2));
    } else {
      // Abatimento FIFO parcial: divide a parcela em paga (remaining) + restante em aberto
      const paidPortion = Number(remaining.toFixed(2));
      const openPortion = Number((entry.amount - paidPortion).toFixed(2));

      const debtInstallments = await tx.splitInstallment.findMany({
        where: { debtId: entry.debtId },
        orderBy: { installmentNumber: 'asc' },
      });

      const targetIndex = debtInstallments.findIndex((i) => i.id === entry.id);
      const nextTotal = debtInstallments.length + 1;

      // Atualiza parcelas posteriores para abrir espaço para a nova parcela
      for (let i = debtInstallments.length - 1; i > targetIndex; i--) {
        await tx.splitInstallment.update({
          where: { id: debtInstallments[i].id },
          data: {
            installmentNumber: debtInstallments[i].installmentNumber + 1,
            totalInstallments: nextTotal,
          },
        });
      }

      // Atualiza parcelas anteriores com novo totalInstallments
      for (let i = 0; i < targetIndex; i++) {
        await tx.splitInstallment.update({
          where: { id: debtInstallments[i].id },
          data: { totalInstallments: nextTotal },
        });
      }

      // Marca parcela atual com o valor abatido
      await tx.splitInstallment.update({
        where: { id: entry.id },
        data: {
          amount: new Prisma.Decimal(paidPortion),
          totalInstallments: nextTotal,
          paid: true,
          paidAt: today,
          paidNote: `${paidNote} (abatimento parcial)`,
        },
      });

      // Cria nova parcela em aberto com o restante
      await tx.splitInstallment.create({
        data: {
          debtId: entry.debtId,
          installmentNumber: entry.installmentNumber + 1,
          totalInstallments: nextTotal,
          amount: new Prisma.Decimal(openPortion),
          dueDate: entry.dueDate,
          paid: false,
        },
      });

      await tx.splitDebt.update({
        where: { id: entry.debtId },
        data: { totalInstallments: nextTotal },
      });

      appliedItems.push({
        debtId: entry.debtId,
        installmentId: entry.id,
        amountApplied: paidPortion,
      });
      remaining = 0;
    }
  }

  return appliedItems;
}

export async function settleFriendBalance(
  friendId: string,
  householdId: string,
  input: SettleFriendInput
) {
  const friend = await prisma.splitFriend.findFirst({
    where: { id: friendId, householdId },
  });
  if (!friend) {
    throw new NotFoundError('Split friend');
  }

  const today = parseDateOnly();

  let monthBounds: { start: Date; end: Date } | null = null;
  if (input.month) {
    const [yearStr, monthStr] = input.month.split('-');
    const year = Number(yearStr);
    const monthIdx = Number(monthStr) - 1;
    monthBounds = {
      start: new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999)),
    };
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const debts = await tx.splitDebt.findMany({
      where: { householdId, friendId },
      include: {
        installments: {
          orderBy: [{ dueDate: 'asc' }, { installmentNumber: 'asc' }],
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    });

    const theyOweMeList: FifoInstallmentEntry[] = [];
    const iOweThemList: FifoInstallmentEntry[] = [];

    for (const debt of debts) {
      for (const inst of debt.installments) {
        if (inst.paid) continue;
        if (
          monthBounds &&
          (inst.dueDate < monthBounds.start || inst.dueDate > monthBounds.end)
        ) {
          continue;
        }
        const entry: FifoInstallmentEntry = {
          id: inst.id,
          debtId: debt.id,
          installmentNumber: inst.installmentNumber,
          totalInstallments: inst.totalInstallments,
          amount: inst.amount.toNumber(),
          dueDate: inst.dueDate,
        };
        if (debt.direction === 'THEY_OWE_ME') {
          theyOweMeList.push(entry);
        } else {
          iOweThemList.push(entry);
        }
      }
    }

    // Ordena estritamente FIFO (dueDate asc, installmentNumber asc)
    theyOweMeList.sort((a, b) => {
      const diff = a.dueDate.getTime() - b.dueDate.getTime();
      return diff !== 0 ? diff : a.installmentNumber - b.installmentNumber;
    });
    iOweThemList.sort((a, b) => {
      const diff = a.dueDate.getTime() - b.dueDate.getTime();
      return diff !== 0 ? diff : a.installmentNumber - b.installmentNumber;
    });

    const owedToMeTotal = Number(
      theyOweMeList.reduce((sum, i) => sum + i.amount, 0).toFixed(2)
    );
    const iOweTotal = Number(
      iOweThemList.reduce((sum, i) => sum + i.amount, 0).toFixed(2)
    );
    const netBalance = Number((owedToMeTotal - iOweTotal).toFixed(2));

    if (theyOweMeList.length === 0 && iOweThemList.length === 0) {
      throw new BadRequestError('Não há saldo em aberto para acertar com este amigo');
    }

    const account = await resolveAccountForSplit(tx, householdId, input.accountId);
    const settlementItems: Array<{
      debtId: string;
      installmentId: string;
      amountApplied: number;
    }> = [];

    let cashPaid = 0;
    let forgivenTotal = 0;
    let direction: 'THEY_PAID_ME' | 'I_PAID_THEM' =
      netBalance >= 0 ? 'THEY_PAID_ME' : 'I_PAID_THEM';
    let settlementTxId: string | null = null;
    let abonoTxId: string | null = null;

    if (netBalance > 0) {
      cashPaid =
        input.mode === 'partial' && input.paidAmount !== undefined
          ? Number(Math.min(netBalance, Math.max(0, input.paidAmount)).toFixed(2))
          : netBalance;

      // 1. Compensa integralmente todas as dívidas I_OWE_THEM
      if (iOweThemList.length > 0) {
        const compensated = await applyFifoInstallmentsInTx(
          tx,
          iOweThemList,
          iOweTotal,
          today,
          'Compensado no acerto líquido'
        );
        settlementItems.push(...compensated);

        // Marca transações pendentes de I_OWE_THEM como paid: true sem duplicar débito na conta
        const iOweDebtIds = Array.from(new Set(iOweThemList.map((i) => i.debtId)));
        await tx.transaction.updateMany({
          where: {
            householdId,
            splitDebtId: { in: iOweDebtIds },
            paid: false,
          },
          data: { paid: true },
        });
      }

      // 2. Aplica (cashPaid + iOweTotal) em FIFO nas dívidas THEY_OWE_ME
      const totalToApply = Number((cashPaid + iOweTotal).toFixed(2));
      const applied = await applyFifoInstallmentsInTx(
        tx,
        theyOweMeList,
        totalToApply,
        today,
        input.month ? `Acerto (${input.month})` : 'Acerto líquido'
      );
      settlementItems.push(...applied);

      // 3. Abono do restante se solicitado
      const remainder = Number(Math.max(0, netBalance - cashPaid).toFixed(2));
      if (input.mode === 'partial' && input.forgiveRemainder && remainder > 0) {
        forgivenTotal = remainder;
        // Remove parcelas ainda não pagas das dívidas THEY_OWE_ME e acumula forgivenAmount
        const remainingUnpaid = await tx.splitInstallment.findMany({
          where: {
            paid: false,
            debt: { householdId, friendId, direction: 'THEY_OWE_ME' },
            ...(monthBounds
              ? { dueDate: { gte: monthBounds.start, lte: monthBounds.end } }
              : {}),
          },
        });

        const forgivenByDebt = new Map<string, number>();
        for (const u of remainingUnpaid) {
          forgivenByDebt.set(
            u.debtId,
            Number(((forgivenByDebt.get(u.debtId) || 0) + u.amount.toNumber()).toFixed(2))
          );
        }

        if (remainingUnpaid.length > 0) {
          await tx.splitInstallment.deleteMany({
            where: { id: { in: remainingUnpaid.map((u) => u.id) } },
          });
        }

        for (const [dId, amt] of forgivenByDebt.entries()) {
          const d = debts.find((x) => x.id === dId);
          const prevForgiven = d?.forgivenAmount ? d.forgivenAmount.toNumber() : 0;
          const remainingCount = await tx.splitInstallment.count({
            where: { debtId: dId },
          });
          await tx.splitDebt.update({
            where: { id: dId },
            data: {
              forgivenAmount: new Prisma.Decimal(Number((prevForgiven + amt).toFixed(2))),
              totalInstallments: Math.max(1, remainingCount),
            },
          });
        }
      }
    } else if (netBalance < 0) {
      direction = 'I_PAID_THEM';
      const absNet = Math.abs(netBalance);
      cashPaid =
        input.mode === 'partial' && input.paidAmount !== undefined
          ? Number(Math.min(absNet, Math.max(0, input.paidAmount)).toFixed(2))
          : absNet;

      // 1. Compensa integralmente todas as dívidas THEY_OWE_ME
      if (theyOweMeList.length > 0) {
        const compensated = await applyFifoInstallmentsInTx(
          tx,
          theyOweMeList,
          owedToMeTotal,
          today,
          'Compensado no acerto líquido'
        );
        settlementItems.push(...compensated);
      }

      // 2. Aplica (cashPaid + owedToMeTotal) em FIFO nas dívidas I_OWE_THEM
      const totalToApply = Number((cashPaid + owedToMeTotal).toFixed(2));
      const applied = await applyFifoInstallmentsInTx(
        tx,
        iOweThemList,
        totalToApply,
        today,
        input.month ? `Pagamento (${input.month})` : 'Pagamento líquido'
      );
      settlementItems.push(...applied);

      // Marca transações pendentes de I_OWE_THEM cujas dívidas ficaram totalmente quitadas como paid: true
      const touchedIOweDebtIds = Array.from(new Set(applied.map((a) => a.debtId)));
      for (const dId of touchedIOweDebtIds) {
        const openCount = await tx.splitInstallment.count({
          where: { debtId: dId, paid: false },
        });
        if (openCount === 0) {
          await tx.transaction.updateMany({
            where: { householdId, splitDebtId: dId, paid: false },
            data: { paid: true },
          });
        }
      }
    } else {
      // netBalance === 0: compensação exata sem transação financeira
      if (theyOweMeList.length > 0) {
        const compA = await applyFifoInstallmentsInTx(
          tx,
          theyOweMeList,
          owedToMeTotal,
          today,
          'Compensado integralmente'
        );
        settlementItems.push(...compA);
      }
      if (iOweThemList.length > 0) {
        const compB = await applyFifoInstallmentsInTx(
          tx,
          iOweThemList,
          iOweTotal,
          today,
          'Compensado integralmente'
        );
        settlementItems.push(...compB);

        const iOweDebtIds = Array.from(new Set(iOweThemList.map((i) => i.debtId)));
        await tx.transaction.updateMany({
          where: {
            householdId,
            splitDebtId: { in: iOweDebtIds },
            paid: false,
          },
          data: { paid: true },
        });
      }
    }

    const settlement = await tx.splitSettlement.create({
      data: {
        householdId,
        friendId,
        direction,
        totalPaid: new Prisma.Decimal(cashPaid),
        forgivenAmount:
          forgivenTotal > 0 ? new Prisma.Decimal(forgivenTotal) : null,
        accountId: account?.id || null,
        settledAt: today,
        notes:
          input.notes ||
          (input.month
            ? `Acerto do mês ${input.month} com ${friend.name}`
            : `Acerto líquido com ${friend.name}`),
        items: {
          create: settlementItems.map((item) => ({
            debtId: item.debtId,
            installmentId: item.installmentId,
            amountApplied: new Prisma.Decimal(item.amountApplied),
          })),
        },
      },
    });

    if (cashPaid > 0) {
      if (direction === 'THEY_PAID_ME') {
        const reimbCategory = await resolveOrCreateCustomCategory(
          tx,
          householdId,
          ['reembolso'],
          'Reembolso',
          CategoryType.INCOME,
          '💸',
          '#10B981'
        );
        const createdIds = await createLinkedTransactionsInTx(tx, {
          householdId,
          type: TransactionType.INCOME,
          accountId: account?.id || null,
          accountType: account?.type || null,
          closingDay: account?.closingDay ?? null,
          categoryName: reimbCategory,
          totalAmount: cashPaid,
          description: `Reembolso: ${friend.name}`,
          baseDate: today,
          totalInstallments: 1,
          paid: true,
          splitSettlementId: settlement.id,
        });
        settlementTxId = createdIds[0] || null;
      } else {
        const debtCategory = await resolveOrCreateCustomCategory(
          tx,
          householdId,
          ['dívida', 'divida'],
          'Dívidas',
          CategoryType.EXPENSE,
          '🤝',
          '#8B5CF6'
        );
        const createdIds = await createLinkedTransactionsInTx(tx, {
          householdId,
          type: TransactionType.EXPENSE,
          accountId: account?.id || null,
          accountType: account?.type || null,
          closingDay: account?.closingDay ?? null,
          categoryName: debtCategory,
          totalAmount: cashPaid,
          description: `Pagamento: ${friend.name}`,
          baseDate: today,
          totalInstallments: 1,
          paid: true,
          splitSettlementId: settlement.id,
        });
        settlementTxId = createdIds[0] || null;
      }
    }

    if (settlementTxId) {
      await tx.splitSettlement.update({
        where: { id: settlement.id },
        data: { settlementTransactionId: settlementTxId },
      });
    }

    const updatedDebts = await tx.splitDebt.findMany({
      where: { householdId, friendId },
      include: DEBT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    return {
      settlementId: settlement.id,
      direction,
      totalPaid: cashPaid,
      forgivenAmount: forgivenTotal,
      settlementTransactionId: settlementTxId,
      abonoTransactionId: abonoTxId,
      debts: updatedDebts.map(serializeDebt),
    };
  });

  return result;
}

export async function settleFriendMonth(
  friendId: string,
  householdId: string,
  month: string,
  accountId?: string | null
) {
  const result = await settleFriendBalance(friendId, householdId, {
    month,
    accountId: accountId || undefined,
    mode: 'full',
    forgiveRemainder: false,
  });
  return result.debts;
}

export async function deleteSplitDebt(debtId: string, householdId: string) {
  const existing = await prisma.splitDebt.findFirst({
    where: { id: debtId, householdId },
  });
  if (!existing) {
    throw new NotFoundError('Split debt');
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Reverte saldo e apaga transações vinculadas diretamente à dívida
    await revertAndDeleteTransactionsInTx(tx, {
      householdId,
      splitDebtId: debtId,
    });

    // 2. Verifica se algum SplitSettlement ficou vazio após remover itens desta dívida
    const items = await tx.splitSettlementItem.findMany({
      where: { debtId },
      select: { settlementId: true },
    });
    const affectedSettlementIds = Array.from(
      new Set(items.map((i) => i.settlementId))
    );

    await tx.splitDebt.delete({
      where: { id: debtId },
    });

    for (const sId of affectedSettlementIds) {
      const remainingItems = await tx.splitSettlementItem.count({
        where: { settlementId: sId },
      });
      if (remainingItems === 0) {
        await revertAndDeleteTransactionsInTx(tx, {
          householdId,
          splitSettlementId: sId,
        });
        await tx.splitSettlement.delete({ where: { id: sId } });
      }
    }
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
          splitDebtId: null,
          splitSettlementId: null,
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

  const createdDebts = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const results: SplitDebtWithRelations[] = [];

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

      const debt = await tx.splitDebt.create({
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

      // Linka a transação original existente sem apagá-la nem recriá-la
      if (isUuid(item.transactionId)) {
        await tx.transaction.updateMany({
          where: { id: item.transactionId, householdId },
          data: { splitDebtId: debt.id },
        });
      }

      // Linka eventuais transações de reembolso via SplitSettlement
      const reimbIds = Array.from(
        new Set(
          [
            item.reimbursementTransactionId,
            ...(item.reimbursementTransactionIds || []),
            ...(item.reimbursements || []).map((r) => r.id),
          ].filter((id): id is string => isUuid(id))
        )
      );

      if (item.paid && (reimbIds.length > 0 || paidAmt > 0)) {
        const settlement = await tx.splitSettlement.create({
          data: {
            householdId,
            friendId: item.friendId,
            direction: 'THEY_PAID_ME',
            totalPaid: new Prisma.Decimal(paidAmt),
            forgivenAmount:
              isPartial && item.forgiveRemainder
                ? new Prisma.Decimal(remainder)
                : null,
            accountId: resolvedAccountId,
            settlementTransactionId: reimbIds[0] || null,
            settledAt: parseDateOnly(item.paidAt || item.date),
            notes: `Importado do histórico legado: ${item.description.trim()}`,
            items: {
              create: [
                {
                  debtId: debt.id,
                  amountApplied: new Prisma.Decimal(paidAmt),
                },
              ],
            },
          },
        });

        if (reimbIds.length > 0) {
          await tx.transaction.updateMany({
            where: { id: { in: reimbIds }, householdId },
            data: { splitSettlementId: settlement.id },
          });
        }
      }

      results.push(debt);
    }

    return results;
  });

  return createdDebts.map(serializeDebt);
}
