import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldExcludeFromPnl } from './transactions.service.js';
import { TransactionType, LoanStatus, AccountType } from '../../shared/enums/index.js';

test('paid loans are excluded from expense reports, while pending or unpaid loans remain counted', () => {
  const paidLoan = shouldExcludeFromPnl({
    type: TransactionType.LOAN,
    loanId: '11111111-1111-1111-1111-111111111111',
    loanStatus: LoanStatus.PAID,
    account: { type: AccountType.CHECKING },
  });

  const pendingLoan = shouldExcludeFromPnl({
    type: TransactionType.LOAN,
    loanId: '22222222-2222-2222-2222-222222222222',
    loanStatus: LoanStatus.PENDING,
    account: { type: AccountType.CHECKING },
  });

  const notPaidCreditCardLoan = shouldExcludeFromPnl({
    type: TransactionType.LOAN,
    loanId: '33333333-3333-3333-3333-333333333333',
    loanStatus: LoanStatus.NOT_PAID,
    account: { type: AccountType.CREDIT },
  });

  assert.equal(paidLoan, true);
  assert.equal(pendingLoan, false);
  assert.equal(notPaidCreditCardLoan, false);
});
