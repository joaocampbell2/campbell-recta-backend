-- AlterTable
ALTER TABLE "households"
ADD COLUMN "is_sandbox" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sandbox_owner_id" UUID,
ADD COLUMN "sandbox_source_household_id" UUID,
ADD COLUMN "sandbox_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "households_is_sandbox_sandbox_owner_id_idx" ON "households"("is_sandbox", "sandbox_owner_id");

-- CreateIndex
CREATE INDEX "households_is_sandbox_sandbox_expires_at_idx" ON "households"("is_sandbox", "sandbox_expires_at");
