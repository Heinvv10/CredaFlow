-- Fair Score audit 2026-10-16, workstream G: daily per-loan arrears history for
-- the NCR return (lib/reports/arrears-snapshot.ts, /api/cron/arrears-snapshot).
-- Additive: one new table; nothing existing changes. No history is backfilled:
-- the loan columns hold only today's position, so the past cannot be rebuilt.

-- CreateTable
CREATE TABLE "LoanArrearsSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "status" "LoanStatus" NOT NULL,
    "ncaRegime" "NcaRegime" NOT NULL,
    "collectionsStage" "CollectionsStage" NOT NULL,
    "daysInArrears" INTEGER NOT NULL,
    "arrearsCents" INTEGER NOT NULL,
    "outstandingPrincipalCents" INTEGER NOT NULL,
    "chargesOutstandingCents" INTEGER NOT NULL,
    "chargesLive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanArrearsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanArrearsSnapshot_tenantId_snapshotDate_idx" ON "LoanArrearsSnapshot"("tenantId", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "LoanArrearsSnapshot_tenantId_loanId_snapshotDate_key" ON "LoanArrearsSnapshot"("tenantId", "loanId", "snapshotDate");

-- AddForeignKey
ALTER TABLE "LoanArrearsSnapshot" ADD CONSTRAINT "LoanArrearsSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanArrearsSnapshot" ADD CONSTRAINT "LoanArrearsSnapshot_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written ────────────────────────────────────────────────────────────

-- A history row is a record of what the book said that day: no negative
-- figures, and once written it is never changed or removed by the application
-- (the cron inserts; a rerun on the same day skips rows that exist).
ALTER TABLE "LoanArrearsSnapshot" ADD CONSTRAINT "LoanArrearsSnapshot_figures_non_negative"
  CHECK ("daysInArrears" >= 0 AND "arrearsCents" >= 0 AND "outstandingPrincipalCents" >= 0 AND "chargesOutstandingCents" >= 0);

CREATE OR REPLACE FUNCTION public."guardLoanArrearsSnapshot"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'Loan arrears history is append-only';
END;
$function$;

CREATE TRIGGER "LoanArrearsSnapshot_append_only"
  BEFORE UPDATE OR DELETE ON "LoanArrearsSnapshot"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanArrearsSnapshot"();

-- Tenant row-level security, as for every tenant table (20261014130000_tenant_rls).
ALTER TABLE "LoanArrearsSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanArrearsSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanArrearsSnapshot" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
