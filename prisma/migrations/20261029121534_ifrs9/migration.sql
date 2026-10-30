-- CreateEnum
CREATE TYPE "Ifrs9InterestBasis" AS ENUM ('FULL_SUSPENSION', 'NET_BASIS');

-- CreateEnum
CREATE TYPE "Ifrs9RunKind" AS ENUM ('MONTHLY', 'ON_DEMAND');

-- CreateTable
CREATE TABLE "Ifrs9Config" (
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFromMonth" TEXT,
    "sicrDpdOver" INTEGER NOT NULL DEFAULT 30,
    "defaultDpd" INTEGER NOT NULL DEFAULT 90,
    "restructuredStage" INTEGER NOT NULL DEFAULT 2,
    "debtReviewStage" INTEGER NOT NULL DEFAULT 2,
    "stage2ProbationMonths" INTEGER NOT NULL DEFAULT 3,
    "stage3ProbationMonths" INTEGER NOT NULL DEFAULT 6,
    "restructuredProbationMonths" INTEGER NOT NULL DEFAULT 12,
    "suspensionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "suspensionDpd" INTEGER NOT NULL DEFAULT 90,
    "suspendOnStage3" BOOLEAN NOT NULL DEFAULT true,
    "stage3InterestBasis" "Ifrs9InterestBasis" NOT NULL DEFAULT 'FULL_SUSPENSION',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ifrs9Config_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Ifrs9EclParameter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "pdBps" INTEGER NOT NULL,
    "lgdBps" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ifrs9EclParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ifrs9SicrFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedById" TEXT,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "Ifrs9SicrFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ifrs9Run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "Ifrs9RunKind" NOT NULL,
    "runDate" DATE NOT NULL,
    "periodKey" TEXT,
    "settings" JSONB NOT NULL,
    "parameters" JSONB NOT NULL,
    "loanCount" INTEGER NOT NULL,
    "totalEadCents" BIGINT NOT NULL,
    "totalEclCents" BIGINT NOT NULL,
    "startedById" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "supersedesRunId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ifrs9Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ifrs9LoanSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "runDate" DATE NOT NULL,
    "loanStatus" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "contractType" TEXT NOT NULL,
    "daysPastDue" INTEGER NOT NULL,
    "stage" INTEGER NOT NULL,
    "triggerStage" INTEGER NOT NULL,
    "previousStage" INTEGER,
    "reasons" TEXT[],
    "stageSince" DATE NOT NULL,
    "cureStartedOn" DATE,
    "restructured" BOOLEAN NOT NULL DEFAULT false,
    "outstandingPrincipalCents" INTEGER NOT NULL,
    "unpaidInterestCents" INTEGER NOT NULL,
    "unpaidFeesCents" INTEGER NOT NULL,
    "chargesOutstandingCents" INTEGER NOT NULL,
    "accruedInterestCents" INTEGER NOT NULL,
    "interestSuspended" BOOLEAN NOT NULL,
    "suspensionBasis" "Ifrs9InterestBasis" NOT NULL,
    "suspendedInterestCents" INTEGER NOT NULL,
    "suspendedDefaultInterestCents" INTEGER NOT NULL,
    "netInterestAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "netDefaultInterestAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "eadCents" INTEGER NOT NULL,
    "parameterScope" TEXT NOT NULL,
    "pdBps" INTEGER NOT NULL,
    "lgdBps" INTEGER NOT NULL,
    "eclCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ifrs9LoanSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ifrs9EclParameter_tenantId_scopeKey_stage_key" ON "Ifrs9EclParameter"("tenantId", "scopeKey", "stage");

-- CreateIndex
CREATE INDEX "Ifrs9SicrFlag_tenantId_loanId_idx" ON "Ifrs9SicrFlag"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "Ifrs9Run_tenantId_runDate_idx" ON "Ifrs9Run"("tenantId", "runDate");

-- CreateIndex
CREATE INDEX "Ifrs9Run_tenantId_periodKey_idx" ON "Ifrs9Run"("tenantId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "Ifrs9Run_tenantId_id_key" ON "Ifrs9Run"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ifrs9Run_tenantId_supersedesRunId_key" ON "Ifrs9Run"("tenantId", "supersedesRunId");

-- CreateIndex
CREATE INDEX "Ifrs9LoanSnapshot_tenantId_loanId_runDate_idx" ON "Ifrs9LoanSnapshot"("tenantId", "loanId", "runDate");

-- CreateIndex
CREATE INDEX "Ifrs9LoanSnapshot_tenantId_runDate_idx" ON "Ifrs9LoanSnapshot"("tenantId", "runDate");

-- CreateIndex
CREATE UNIQUE INDEX "Ifrs9LoanSnapshot_runId_loanId_key" ON "Ifrs9LoanSnapshot"("runId", "loanId");

-- AddForeignKey
ALTER TABLE "Ifrs9Config" ADD CONSTRAINT "Ifrs9Config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ifrs9EclParameter" ADD CONSTRAINT "Ifrs9EclParameter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ifrs9SicrFlag" ADD CONSTRAINT "Ifrs9SicrFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ifrs9SicrFlag" ADD CONSTRAINT "Ifrs9SicrFlag_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ifrs9Run" ADD CONSTRAINT "Ifrs9Run_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ifrs9Run" ADD CONSTRAINT "Ifrs9Run_tenantId_supersedesRunId_fkey" FOREIGN KEY ("tenantId", "supersedesRunId") REFERENCES "Ifrs9Run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ifrs9LoanSnapshot" ADD CONSTRAINT "Ifrs9LoanSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ifrs9LoanSnapshot" ADD CONSTRAINT "Ifrs9LoanSnapshot_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "Ifrs9Run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ifrs9LoanSnapshot" ADD CONSTRAINT "Ifrs9LoanSnapshot_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written ────────────────────────────────────────────────────────────

-- Policy bounds (lib/ifrs9/settings.ts): Stage 2 starts before Stage 3, and interest is suspended only in Stage 3
-- (suspensionDpd is never below the default threshold, so a DPD trigger cannot suspend a Stage 2 loan).
ALTER TABLE "Ifrs9Config" ADD CONSTRAINT "Ifrs9Config_policy_bounds" CHECK (
  "sicrDpdOver" BETWEEN 1 AND 3650 AND "defaultDpd" BETWEEN 1 AND 3650 AND "suspensionDpd" BETWEEN 1 AND 3650
  AND "sicrDpdOver" < "defaultDpd" AND "suspensionDpd" >= "defaultDpd"
  AND "restructuredStage" IN (1, 2, 3) AND "debtReviewStage" IN (1, 2, 3)
  AND "stage2ProbationMonths" BETWEEN 0 AND 60 AND "stage3ProbationMonths" BETWEEN 0 AND 60
  AND "restructuredProbationMonths" BETWEEN 0 AND 60
  AND ("effectiveFromMonth" IS NULL OR "effectiveFromMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

-- PD and LGD are basis points; a scope is the lender default, a contract type or one product. Stage 3 is
-- credit-impaired: its PD is 100% by definition.
ALTER TABLE "Ifrs9EclParameter" ADD CONSTRAINT "Ifrs9EclParameter_bounds" CHECK (
  "stage" IN (1, 2, 3) AND "pdBps" BETWEEN 0 AND 10000 AND "lgdBps" BETWEEN 0 AND 10000
  AND ("stage" <> 3 OR "pdBps" = 10000)
  AND "scopeKey" ~ '^(DEFAULT|CONTRACT:[A-Z_]{1,40}|PRODUCT:[A-Za-z0-9_-]{1,40})$'
);

ALTER TABLE "Ifrs9SicrFlag" ADD CONSTRAINT "Ifrs9SicrFlag_kind_reason" CHECK (
  "kind" IN ('BUREAU_DOWNGRADE', 'BEHAVIOUR_DOWNGRADE', 'WATCHLIST', 'OTHER') AND length(btrim("reason")) > 0
);

-- A MONTHLY run stands for a month and is dated that month's last day; an ON_DEMAND one stands for none. Only a
-- MONTHLY run is late or supersedes, and a superseding run says why.
ALTER TABLE "Ifrs9Run" ADD CONSTRAINT "Ifrs9Run_shape" CHECK (
  ("kind" = 'MONTHLY') = ("periodKey" IS NOT NULL)
  AND ("periodKey" IS NULL OR "periodKey" ~ '^\d{4}-(0[1-9]|1[0-2])$')
  AND ("kind" <> 'MONTHLY' OR "runDate" = ((("periodKey" || '-01')::date + interval '1 month') - interval '1 day')::date)
  AND ("kind" = 'MONTHLY' OR (NOT "late" AND "supersedesRunId" IS NULL))
  AND ("supersedesRunId" IS NULL OR length(btrim(coalesce("reason", ''))) > 0)
  AND "loanCount" >= 0 AND "totalEadCents" >= 0 AND "totalEclCents" >= 0
  AND jsonb_typeof("settings") = 'object' AND jsonb_typeof("parameters") = 'array'
);

-- One original MONTHLY run per tenant per month; a correction is a run that supersedes it (the unique index on
-- (tenantId, supersedesRunId) above lets each run be superseded once, so a month's runs form one chain).
CREATE UNIQUE INDEX "Ifrs9Run_original_monthly_key" ON "Ifrs9Run"("tenantId", "periodKey")
  WHERE "kind" = 'MONTHLY' AND "supersedesRunId" IS NULL;

-- A MONTHLY run is the evidence a month's accounting close reads, so none may be added for a month that has
-- closed (or is closing: the application takes the accounting lock first), and a superseding run must be for the
-- same month as the run it replaces.
CREATE OR REPLACE FUNCTION public."guardIfrs9MonthlyRun"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."kind" <> 'MONTHLY' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "AccountingExportBatch" b WHERE b."tenantId" = NEW."tenantId" AND b."periodKey" = NEW."periodKey") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The accounting period of this IFRS 9 run is closed';
  END IF;
  IF NEW."supersedesRunId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Ifrs9Run" r
    WHERE r."id" = NEW."supersedesRunId" AND r."tenantId" = NEW."tenantId" AND r."kind" = 'MONTHLY' AND r."periodKey" = NEW."periodKey"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A superseding IFRS 9 run must be for the same month as the run it replaces';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Ifrs9Run_monthly_guard"
  BEFORE INSERT ON "Ifrs9Run"
  FOR EACH ROW EXECUTE FUNCTION public."guardIfrs9MonthlyRun"();

-- A snapshot is internally consistent whatever wrote it: the stage is 1-3, and only a Stage 3 loan has its interest
-- suspended or adjusted; interest is suspended only on the full-suspension basis (all the raised, unpaid interest, and
-- the exposure is the sum of its parts less what is in suspense) and adjusted only on the net basis (no suspense, the
-- exposure stays gross); and the ECL is EAD x PD x LGD to the nearest cent, half up (lib/ifrs9/ecl.ts).
ALTER TABLE "Ifrs9LoanSnapshot" ADD CONSTRAINT "Ifrs9LoanSnapshot_stage_bounds" CHECK (
  "stage" IN (1, 2, 3) AND "triggerStage" IN (1, 2, 3) AND ("previousStage" IS NULL OR "previousStage" IN (1, 2, 3))
  AND "triggerStage" <= "stage" AND "daysPastDue" >= 0
  AND (NOT "interestSuspended" OR "stage" = 3)
  AND ("stage" = 3 OR ("netInterestAdjustmentCents" = 0 AND "netDefaultInterestAdjustmentCents" = 0))
);

ALTER TABLE "Ifrs9LoanSnapshot" ADD CONSTRAINT "Ifrs9LoanSnapshot_figures" CHECK (
  "outstandingPrincipalCents" >= 0 AND "unpaidInterestCents" >= 0 AND "unpaidFeesCents" >= 0
  AND "chargesOutstandingCents" >= 0 AND "accruedInterestCents" >= 0
  AND "suspendedInterestCents" >= 0 AND "suspendedDefaultInterestCents" >= 0
  AND "netInterestAdjustmentCents" >= 0 AND "netDefaultInterestAdjustmentCents" >= 0
  AND "pdBps" BETWEEN 0 AND 10000 AND "lgdBps" BETWEEN 0 AND 10000
  AND "suspendedInterestCents" <= "unpaidInterestCents" AND "suspendedDefaultInterestCents" <= "chargesOutstandingCents"
  AND ("interestSuspended" OR ("suspendedInterestCents" = 0 AND "suspendedDefaultInterestCents" = 0))
  AND (NOT "interestSuspended" OR ("suspensionBasis" = 'FULL_SUSPENSION' AND "suspendedInterestCents" = "unpaidInterestCents"))
  AND ("suspensionBasis" = 'NET_BASIS' OR ("netInterestAdjustmentCents" = 0 AND "netDefaultInterestAdjustmentCents" = 0))
  AND "eadCents" = GREATEST(
    "outstandingPrincipalCents"::bigint + "unpaidInterestCents" + "unpaidFeesCents" + "chargesOutstandingCents" + "accruedInterestCents"
      - CASE WHEN "interestSuspended" THEN "suspendedInterestCents" + "suspendedDefaultInterestCents" ELSE 0 END, 0)
  AND "eclCents" = div("eadCents"::numeric * "pdBps" * "lgdBps" + 50000000, 100000000)
);

-- Runs and their loan snapshots are the evidence for a provision: append-only, no UPDATE, DELETE or
-- TRUNCATE (as LoanArrearsSnapshot, 20261017090000_loan_arrears_snapshot). A wrong run is answered by
-- the next one (a superseding run while its month is open), never edited.
CREATE OR REPLACE FUNCTION public."guardIfrs9Run"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'IFRS 9 runs and loan snapshots are append-only';
END;
$function$;

CREATE TRIGGER "Ifrs9Run_append_only"
  BEFORE UPDATE OR DELETE ON "Ifrs9Run"
  FOR EACH ROW EXECUTE FUNCTION public."guardIfrs9Run"();
CREATE TRIGGER "Ifrs9Run_guard_truncate"
  BEFORE TRUNCATE ON "Ifrs9Run"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardIfrs9Run"();
CREATE TRIGGER "Ifrs9LoanSnapshot_append_only"
  BEFORE UPDATE OR DELETE ON "Ifrs9LoanSnapshot"
  FOR EACH ROW EXECUTE FUNCTION public."guardIfrs9Run"();
CREATE TRIGGER "Ifrs9LoanSnapshot_guard_truncate"
  BEFORE TRUNCATE ON "Ifrs9LoanSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardIfrs9Run"();

-- Tenant row-level security, as for every tenant table (20261014130000_tenant_rls).
ALTER TABLE "Ifrs9Config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ifrs9Config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Ifrs9Config" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Ifrs9EclParameter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ifrs9EclParameter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Ifrs9EclParameter" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Ifrs9SicrFlag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ifrs9SicrFlag" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Ifrs9SicrFlag" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Ifrs9Run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ifrs9Run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Ifrs9Run" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Ifrs9LoanSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ifrs9LoanSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Ifrs9LoanSnapshot" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
