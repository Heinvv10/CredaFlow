-- Bureau framework (lib/bureau): per-tenant provider order, sealed
-- credentials and report freshness; per-attempt bookkeeping on the check.
-- Additive. The CHECK constrains a column that no running code writes yet.

-- AlterTable
ALTER TABLE "CreditBureauCheck" ADD COLUMN     "attempt" INTEGER,
ADD COLUMN     "status" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "bureauCredentials" TEXT,
ADD COLUMN     "bureauMaxAgeDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "bureauProviderOrder" TEXT[] DEFAULT ARRAY['experian']::TEXT[];

-- Hand-written: prisma migrate dev never diffs a CHECK.
-- A report older than 60 days is never current (BUREAU_STALENESS_DAYS in
-- lib/compliance/bureau.ts); a tenant may only tighten that window.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_bureauMaxAgeDays_range"
  CHECK ("bureauMaxAgeDays" BETWEEN 1 AND 60);
