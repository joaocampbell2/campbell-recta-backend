-- AlterTable: add best_day_offset to accounts so the user can configure
-- how many days before the invoice closes the "best day to buy" is computed.
ALTER TABLE "accounts" ADD COLUMN "best_day_offset" INTEGER;
