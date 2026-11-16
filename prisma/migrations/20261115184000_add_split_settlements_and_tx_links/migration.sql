-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "split_debt_id" UUID,
ADD COLUMN "split_settlement_id" UUID;

-- CreateTable
CREATE TABLE "split_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "household_id" UUID NOT NULL,
    "friend_id" UUID NOT NULL,
    "direction" VARCHAR(30) NOT NULL,
    "total_paid" DECIMAL(15,2) NOT NULL,
    "forgiven_amount" DECIMAL(15,2),
    "account_id" UUID,
    "settlement_transaction_id" UUID,
    "abono_transaction_id" UUID,
    "settled_at" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_settlement_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settlement_id" UUID NOT NULL,
    "debt_id" UUID NOT NULL,
    "installment_id" UUID,
    "amount_applied" DECIMAL(15,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "split_settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transactions_split_debt_id_idx" ON "transactions"("split_debt_id");

-- CreateIndex
CREATE INDEX "transactions_split_settlement_id_idx" ON "transactions"("split_settlement_id");

-- CreateIndex
CREATE INDEX "split_settlements_household_id_idx" ON "split_settlements"("household_id");

-- CreateIndex
CREATE INDEX "split_settlements_friend_id_idx" ON "split_settlements"("friend_id");

-- CreateIndex
CREATE INDEX "split_settlements_account_id_idx" ON "split_settlements"("account_id");

-- CreateIndex
CREATE INDEX "split_settlements_settlement_transaction_id_idx" ON "split_settlements"("settlement_transaction_id");

-- CreateIndex
CREATE INDEX "split_settlements_abono_transaction_id_idx" ON "split_settlements"("abono_transaction_id");

-- CreateIndex
CREATE INDEX "split_settlement_items_settlement_id_idx" ON "split_settlement_items"("settlement_id");

-- CreateIndex
CREATE INDEX "split_settlement_items_debt_id_idx" ON "split_settlement_items"("debt_id");

-- CreateIndex
CREATE INDEX "split_settlement_items_installment_id_idx" ON "split_settlement_items"("installment_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_split_debt_id_fkey" FOREIGN KEY ("split_debt_id") REFERENCES "split_debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_split_settlement_id_fkey" FOREIGN KEY ("split_settlement_id") REFERENCES "split_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlements" ADD CONSTRAINT "split_settlements_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlements" ADD CONSTRAINT "split_settlements_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "split_friends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlements" ADD CONSTRAINT "split_settlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlement_items" ADD CONSTRAINT "split_settlement_items_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "split_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlement_items" ADD CONSTRAINT "split_settlement_items_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "split_debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_settlement_items" ADD CONSTRAINT "split_settlement_items_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "split_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
