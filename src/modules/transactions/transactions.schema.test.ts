import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionSchema } from './transactions.schema.js';
import { TransactionType, CategoryName } from '../../shared/enums/index.js';

test('createTransactionSchema accepts loan transactions with a borrower name', () => {
  const parsed = createTransactionSchema.parse({
    householdId: '11111111-1111-1111-1111-111111111111',
    type: TransactionType.LOAN,
    accountId: '22222222-2222-2222-2222-222222222222',
    amount: 150,
    description: 'Empréstimo para João',
    date: '2026-06-25',
    loanPersonName: 'João',
    loanStatus: 'PENDING',
    paid: false,
  });

  assert.equal(parsed.type, TransactionType.LOAN);
  assert.equal(parsed.loanPersonName, 'João');
  assert.equal(parsed.loanStatus, 'PENDING');
});

test('createTransactionSchema accepts loan repayment income linked to a loan', () => {
  const parsed = createTransactionSchema.parse({
    householdId: '11111111-1111-1111-1111-111111111111',
    type: TransactionType.INCOME,
    accountId: '22222222-2222-2222-2222-222222222222',
    categoryName: 'OTHER_INCOME',
    amount: 150,
    description: 'Recebimento do empréstimo',
    date: '2026-06-26',
    loanId: '33333333-3333-3333-3333-333333333333',
  });

  assert.equal(parsed.loanId, '33333333-3333-3333-3333-333333333333');
});

test('createTransactionSchema accepts expense transactions without an explicit loanStatus', () => {
  const parsed = createTransactionSchema.parse({
    householdId: '11111111-1111-1111-1111-111111111111',
    type: TransactionType.EXPENSE,
    accountId: '22222222-2222-2222-2222-222222222222',
    categoryName: CategoryName.OTHER_EXPENSES,
    amount: 10,
    description: 'Despesa simples',
    date: '2026-06-25',
    paid: true,
    isSplit: false,
  });

  assert.equal(parsed.loanStatus, undefined);
});
