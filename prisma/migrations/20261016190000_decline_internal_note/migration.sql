-- Fair Score audit 2026-10-16 (workstream D): a decline separates the staff-only
-- note from the reason shown to the client, and gains Fraud / Policy / Other
-- categories. Additive only: a nullable column and new enum values, so the
-- running code is unaffected until it writes them. The new values are not used
-- in this transaction (ALTER TYPE ... ADD VALUE).

-- AlterEnum
ALTER TYPE "DeclineCategory" ADD VALUE 'FRAUD';
ALTER TYPE "DeclineCategory" ADD VALUE 'POLICY';
ALTER TYPE "DeclineCategory" ADD VALUE 'OTHER';

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN "declineInternalNote" TEXT;
