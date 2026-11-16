-- AlterTable
ALTER TABLE "categories" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "categories_household_id_deleted_at_idx" ON "categories"("household_id", "deleted_at");
