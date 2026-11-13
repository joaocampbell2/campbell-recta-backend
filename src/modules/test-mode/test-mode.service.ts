import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import {
  isCustomCategoryName,
  toCustomCategoryId,
  toCustomCategoryName,
} from '../../shared/utils/categoryHelpers.js';

const SANDBOX_TTL_HOURS = 24;

export interface TestModeStatus {
  active: boolean;
  sandboxHouseholdId: string | null;
  sourceHouseholdId: string | null;
  expiresAt: string | null;
}

function remapCategoryName(
  categoryName: string | null | undefined,
  categoryMap: Map<string, string>
): string | null {
  if (!categoryName) return null;
  if (isCustomCategoryName(categoryName)) {
    const oldId = toCustomCategoryId(categoryName);
    if (oldId && categoryMap.has(oldId)) {
      return toCustomCategoryName(categoryMap.get(oldId)!);
    }
  }
  return categoryName;
}

async function deleteSandboxHouseholdsByIds(
  tx: Prisma.TransactionClient,
  householdIds: string[]
) {
  if (householdIds.length === 0) return;

  await tx.notification.deleteMany({
    where: {
      OR: householdIds.map((id) => ({
        metadata: {
          path: ['householdId'],
          equals: id,
        },
      })),
    },
  });

  await tx.household.deleteMany({
    where: {
      id: { in: householdIds },
      isSandbox: true,
    },
  });
}

/**
 * Remove expired sandbox households to keep the database clean
 */
export async function cleanupExpiredSandboxes(): Promise<void> {
  const expired = await prisma.household.findMany({
    where: {
      isSandbox: true,
      sandboxExpiresAt: { lt: new Date() },
    },
    select: { id: true },
  });

  if (expired.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await deleteSandboxHouseholdsByIds(
      tx,
      expired.map((h) => h.id)
    );
  });
}

/**
 * Get current test-mode status for a user
 */
export async function getTestModeStatus(userId: string): Promise<TestModeStatus> {
  await cleanupExpiredSandboxes();

  const activeSandbox = await prisma.household.findFirst({
    where: {
      isSandbox: true,
      sandboxOwnerId: userId,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sandboxSourceHouseholdId: true,
      sandboxExpiresAt: true,
    },
  });

  if (!activeSandbox) {
    return {
      active: false,
      sandboxHouseholdId: null,
      sourceHouseholdId: null,
      expiresAt: null,
    };
  }

  return {
    active: true,
    sandboxHouseholdId: activeSandbox.id,
    sourceHouseholdId: activeSandbox.sandboxSourceHouseholdId ?? null,
    expiresAt: activeSandbox.sandboxExpiresAt?.toISOString() ?? null,
  };
}

/**
 * Start test mode by cloning the user's source household into an isolated sandbox household
 */
export async function startTestMode(
  userId: string,
  sourceHouseholdId: string
): Promise<TestModeStatus> {
  await cleanupExpiredSandboxes();

  const sourceHousehold = await prisma.household.findUnique({
    where: { id: sourceHouseholdId },
    select: { id: true, name: true, isSandbox: true },
  });

  if (!sourceHousehold) {
    throw new NotFoundError('Household');
  }

  if (sourceHousehold.isSandbox) {
    throw new BadRequestError('Cannot start test mode from an existing sandbox household');
  }

  const expiresAt = new Date(Date.now() + SANDBOX_TTL_HOURS * 60 * 60 * 1000);

  const [
    categories,
    accounts,
    recurringTransactions,
    savingsGoals,
    budgets,
    transactions,
    splitFriends,
    splitGroups,
    splitGroupMembers,
    splitDebts,
    splitInstallments,
    existingSandboxes,
  ] = await Promise.all([
    prisma.category.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.account.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.recurringTransaction.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.savingsGoal.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.budget.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.transaction.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.splitFriend.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.splitGroup.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.splitGroupMember.findMany({
      where: { group: { householdId: sourceHouseholdId } },
    }),
    prisma.splitDebt.findMany({ where: { householdId: sourceHouseholdId } }),
    prisma.splitInstallment.findMany({
      where: { debt: { householdId: sourceHouseholdId } },
    }),
    prisma.household.findMany({
      where: { isSandbox: true, sandboxOwnerId: userId },
      select: { id: true },
    }),
  ]);

  const sandboxHousehold = await prisma.$transaction(
    async (tx) => {
      if (existingSandboxes.length > 0) {
        await deleteSandboxHouseholdsByIds(
          tx,
          existingSandboxes.map((s) => s.id)
        );
      }

      const createdSandbox = await tx.household.create({
        data: {
          name: `[TESTE] ${sourceHousehold.name}`,
          isSandbox: true,
          sandboxOwnerId: userId,
          sandboxSourceHouseholdId: sourceHouseholdId,
          sandboxExpiresAt: expiresAt,
        },
      });

      const sandboxId = createdSandbox.id;

      await tx.householdMember.create({
        data: {
          householdId: sandboxId,
          userId,
          role: 'OWNER',
        },
      });

      // 1. Categories
      const categoryMap = new Map<string, string>();
      if (categories.length > 0) {
        await tx.category.createMany({
          data: categories.map((cat) => {
            const id = randomUUID();
            categoryMap.set(cat.id, id);
            return {
              id,
              householdId: sandboxId,
              name: cat.name,
              type: cat.type,
              icon: cat.icon,
              color: cat.color,
            };
          }),
        });
      }

      // 2. Accounts (create first, then link linkedAccountId)
      const accountMap = new Map<string, string>();
      if (accounts.length > 0) {
        await tx.account.createMany({
          data: accounts.map((acc) => {
            const id = randomUUID();
            accountMap.set(acc.id, id);
            return {
              id,
              householdId: sandboxId,
              name: acc.name,
              type: acc.type,
              balance: acc.balance,
              currency: acc.currency,
              isActive: acc.isActive,
              status: acc.status,
              color: acc.color,
              icon: acc.icon,
              totalBalance: acc.totalBalance,
              availableBalance: acc.availableBalance,
              allocatedBalance: acc.allocatedBalance,
              creditLimit: acc.creditLimit,
              totalLimit: acc.totalLimit,
              availableLimit: acc.availableLimit,
              dueDay: acc.dueDay,
              closingDay: acc.closingDay,
              bestDayOffset: acc.bestDayOffset,
            };
          }),
        });

        for (const acc of accounts) {
          if (acc.linkedAccountId && accountMap.has(acc.linkedAccountId)) {
            await tx.account.update({
              where: { id: accountMap.get(acc.id)! },
              data: { linkedAccountId: accountMap.get(acc.linkedAccountId)! },
            });
          }
        }
      }

      // 3. Recurring transactions
      const recurringMap = new Map<string, string>();
      const recurringData = recurringTransactions.flatMap((rec) => {
        const mappedAccountId = accountMap.get(rec.accountId);
        if (!mappedAccountId) return [];

        const id = randomUUID();
        recurringMap.set(rec.id, id);
        return [
          {
            id,
            householdId: sandboxId,
            accountId: mappedAccountId,
            categoryName:
              remapCategoryName(rec.categoryName, categoryMap) ?? rec.categoryName,
            amount: rec.amount,
            description: rec.description,
            frequency: rec.frequency,
            startDate: rec.startDate,
            endDate: rec.endDate,
            nextRunAt: rec.nextRunAt,
            lastRunDate: rec.lastRunDate,
            isActive: rec.isActive,
          },
        ];
      });
      if (recurringData.length > 0) {
        await tx.recurringTransaction.createMany({ data: recurringData });
      }

      // 4. Savings goals
      if (savingsGoals.length > 0) {
        await tx.savingsGoal.createMany({
          data: savingsGoals.map((goal) => ({
            householdId: sandboxId,
            accountId: goal.accountId ? accountMap.get(goal.accountId) ?? null : null,
            name: goal.name,
            targetAmount: goal.targetAmount,
            currentAmount: goal.currentAmount,
            targetDate: goal.targetDate,
          })),
        });
      }

      // 5. Budgets
      if (budgets.length > 0) {
        await tx.budget.createMany({
          data: budgets.map((budget) => ({
            householdId: sandboxId,
            categoryName:
              remapCategoryName(budget.categoryName, categoryMap) ??
              budget.categoryName,
            monthlyLimit: budget.monthlyLimit,
            month: budget.month,
            type: budget.type,
          })),
        });
      }

      // 6. Transactions
      const txMap = new Map<string, string>();
      if (transactions.length > 0) {
        await tx.transaction.createMany({
          data: transactions.map((item) => {
            const id = randomUUID();
            txMap.set(item.id, id);
            return {
              id,
              householdId: sandboxId,
              type: item.type,
              accountId: item.accountId ? accountMap.get(item.accountId) ?? null : null,
              categoryName: remapCategoryName(item.categoryName, categoryMap),
              amount: item.amount,
              description: item.description,
              date: item.date,
              notes: item.notes,
              paid: item.paid,
              fromAccountId: item.fromAccountId
                ? accountMap.get(item.fromAccountId) ?? null
                : null,
              toAccountId: item.toAccountId
                ? accountMap.get(item.toAccountId) ?? null
                : null,
              relatedEntityId: item.relatedEntityId
                ? accountMap.get(item.relatedEntityId) ?? null
                : null,
              recurringTransactionId: item.recurringTransactionId
                ? recurringMap.get(item.recurringTransactionId) ?? null
                : null,
              installmentId: item.installmentId,
              installmentNumber: item.installmentNumber,
              totalInstallments: item.totalInstallments,
              attachmentUrl: item.attachmentUrl,
              isSplit: false,
            };
          }),
        });
      }

      // 7. Split friends
      const friendMap = new Map<string, string>();
      if (splitFriends.length > 0) {
        await tx.splitFriend.createMany({
          data: splitFriends.map((friend) => {
            const id = randomUUID();
            friendMap.set(friend.id, id);
            return {
              id,
              householdId: sandboxId,
              name: friend.name,
              emailOrPix: friend.emailOrPix,
              avatarColor: friend.avatarColor,
              avatarUrl: friend.avatarUrl,
              archived: friend.archived,
            };
          }),
        });
      }

      // 8. Split groups & members
      const groupMap = new Map<string, string>();
      if (splitGroups.length > 0) {
        await tx.splitGroup.createMany({
          data: splitGroups.map((group) => {
            const id = randomUUID();
            groupMap.set(group.id, id);
            return {
              id,
              householdId: sandboxId,
              name: group.name,
              category: group.category,
              avatarUrl: group.avatarUrl,
              archived: group.archived,
            };
          }),
        });
      }

      const groupMemberData = splitGroupMembers.flatMap((member) => {
        const mappedGroupId = groupMap.get(member.groupId);
        const mappedFriendId = friendMap.get(member.friendId);
        if (!mappedGroupId || !mappedFriendId) return [];

        return [{ groupId: mappedGroupId, friendId: mappedFriendId }];
      });
      if (groupMemberData.length > 0) {
        await tx.splitGroupMember.createMany({ data: groupMemberData });
      }

      // 9. Split debts & installments
      const debtMap = new Map<string, string>();
      const splitDebtData = splitDebts.flatMap((debt) => {
        const mappedFriendId = friendMap.get(debt.friendId);
        if (!mappedFriendId) return [];

        const id = randomUUID();
        debtMap.set(debt.id, id);
        return [
          {
            id,
            householdId: sandboxId,
            description: debt.description,
            category: remapCategoryName(debt.category, categoryMap),
            accountId: debt.accountId ? accountMap.get(debt.accountId) ?? null : null,
            accountName: debt.accountName,
            originalTotalAmount: debt.originalTotalAmount,
            debtTotalAmount: debt.debtTotalAmount,
            forgivenAmount: debt.forgivenAmount,
            direction: debt.direction,
            payerFriendId: debt.payerFriendId
              ? friendMap.get(debt.payerFriendId) ?? null
              : null,
            splitRule: debt.splitRule,
            friendId: mappedFriendId,
            groupId: debt.groupId ? groupMap.get(debt.groupId) ?? null : null,
            totalInstallments: debt.totalInstallments,
            legacyTransactionId: debt.legacyTransactionId
              ? txMap.get(debt.legacyTransactionId) ?? debt.legacyTransactionId
              : null,
            createdAt: debt.createdAt,
          },
        ];
      });
      if (splitDebtData.length > 0) {
        await tx.splitDebt.createMany({ data: splitDebtData });
      }

      const installmentData = splitInstallments.flatMap((inst) => {
        const mappedDebtId = debtMap.get(inst.debtId);
        if (!mappedDebtId) return [];

        return [
          {
            debtId: mappedDebtId,
            installmentNumber: inst.installmentNumber,
            totalInstallments: inst.totalInstallments,
            amount: inst.amount,
            dueDate: inst.dueDate,
            paid: inst.paid,
            paidAt: inst.paidAt,
            paidNote: inst.paidNote,
            legacyReimbursementTxId: inst.legacyReimbursementTxId
              ? txMap.get(inst.legacyReimbursementTxId) ?? inst.legacyReimbursementTxId
              : null,
          },
        ];
      });
      if (installmentData.length > 0) {
        await tx.splitInstallment.createMany({ data: installmentData });
      }

      return createdSandbox;
    },
    { timeout: 30000 }
  );

  return {
    active: true,
    sandboxHouseholdId: sandboxHousehold.id,
    sourceHouseholdId,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Stop test mode and delete all sandbox households owned by the user
 */
export async function stopTestMode(userId: string): Promise<{
  active: false;
  restoredHouseholdId: string | null;
}> {
  const sandboxes = await prisma.household.findMany({
    where: {
      isSandbox: true,
      sandboxOwnerId: userId,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sandboxSourceHouseholdId: true,
    },
  });

  const restoredHouseholdId = sandboxes[0]?.sandboxSourceHouseholdId ?? null;

  if (sandboxes.length > 0) {
    await prisma.$transaction(async (tx) => {
      await deleteSandboxHouseholdsByIds(
        tx,
        sandboxes.map((s) => s.id)
      );
    });
  }

  return {
    active: false,
    restoredHouseholdId,
  };
}
