-- CreateTable
CREATE TABLE "split_friends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "household_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "email_or_pix" VARCHAR(255),
    "avatar_color" VARCHAR(50) NOT NULL DEFAULT 'bg-purple-500',
    "avatar_url" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_friends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "household_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" VARCHAR(50) NOT NULL DEFAULT 'other',
    "avatar_url" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_group_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "friend_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "split_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_debts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "household_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(100),
    "account_id" UUID,
    "account_name" VARCHAR(150),
    "original_total_amount" DECIMAL(15,2) NOT NULL,
    "debt_total_amount" DECIMAL(15,2) NOT NULL,
    "forgiven_amount" DECIMAL(15,2),
    "direction" VARCHAR(30) NOT NULL,
    "payer_friend_id" UUID,
    "split_rule" VARCHAR(30) NOT NULL,
    "friend_id" UUID NOT NULL,
    "group_id" UUID,
    "total_installments" INTEGER NOT NULL DEFAULT 1,
    "legacy_transaction_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_installments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "debt_id" UUID NOT NULL,
    "installment_number" INTEGER NOT NULL,
    "total_installments" INTEGER NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "due_date" DATE NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paid_at" DATE,
    "paid_note" TEXT,
    "legacy_reimbursement_tx_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "split_friends_household_id_idx" ON "split_friends"("household_id");

-- CreateIndex
CREATE INDEX "split_friends_household_id_archived_idx" ON "split_friends"("household_id", "archived");

-- CreateIndex
CREATE INDEX "split_groups_household_id_idx" ON "split_groups"("household_id");

-- CreateIndex
CREATE INDEX "split_groups_household_id_archived_idx" ON "split_groups"("household_id", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "split_group_members_group_id_friend_id_key" ON "split_group_members"("group_id", "friend_id");

-- CreateIndex
CREATE INDEX "split_group_members_group_id_idx" ON "split_group_members"("group_id");

-- CreateIndex
CREATE INDEX "split_group_members_friend_id_idx" ON "split_group_members"("friend_id");

-- CreateIndex
CREATE INDEX "split_debts_household_id_idx" ON "split_debts"("household_id");

-- CreateIndex
CREATE INDEX "split_debts_friend_id_idx" ON "split_debts"("friend_id");

-- CreateIndex
CREATE INDEX "split_debts_group_id_idx" ON "split_debts"("group_id");

-- CreateIndex
CREATE INDEX "split_debts_account_id_idx" ON "split_debts"("account_id");

-- CreateIndex
CREATE INDEX "split_debts_legacy_transaction_id_idx" ON "split_debts"("legacy_transaction_id");

-- CreateIndex
CREATE INDEX "split_installments_debt_id_idx" ON "split_installments"("debt_id");

-- CreateIndex
CREATE INDEX "split_installments_due_date_idx" ON "split_installments"("due_date");

-- CreateIndex
CREATE INDEX "split_installments_paid_idx" ON "split_installments"("paid");

-- CreateIndex
CREATE INDEX "split_installments_legacy_reimbursement_tx_id_idx" ON "split_installments"("legacy_reimbursement_tx_id");

-- AddForeignKey
ALTER TABLE "split_friends" ADD CONSTRAINT "split_friends_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_groups" ADD CONSTRAINT "split_groups_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_group_members" ADD CONSTRAINT "split_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "split_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_group_members" ADD CONSTRAINT "split_group_members_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "split_friends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_debts" ADD CONSTRAINT "split_debts_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_debts" ADD CONSTRAINT "split_debts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_debts" ADD CONSTRAINT "split_debts_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "split_friends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_debts" ADD CONSTRAINT "split_debts_payer_friend_id_fkey" FOREIGN KEY ("payer_friend_id") REFERENCES "split_friends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_debts" ADD CONSTRAINT "split_debts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "split_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_installments" ADD CONSTRAINT "split_installments_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "split_debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
