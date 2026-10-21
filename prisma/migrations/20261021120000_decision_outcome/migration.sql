-- Learning loop, PR B: decision outcomes (docs/learning-loop/DESIGN.md §3-§4).
-- Additive: one new table, two enums, and a (tenantId, id) unique index on
-- CreditDecisionRecord so an outcome's foreign key carries the tenant (an
-- index is not an UPDATE: the append-only trigger does not fire). Nothing
-- existing changes. The code that writes it (lib/learning-loop/outcomes/,
-- /api/cron/decision-outcomes) ships in the same release; the CHECKs below
-- refuse only rows that code never writes.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TABLE "DecisionOutcome";
--   DROP TYPE "DecisionOutcomeKind";
--   DROP TYPE "DecisionOutcomeState";
--   DROP INDEX "CreditDecisionRecord_tenantId_id_key";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021120000_decision_outcome';
--   COMMIT;
-- Every row is derived and the nightly job recomputes it, so dropping the
-- table loses nothing that cannot be rebuilt.

-- CreateEnum
CREATE TYPE "DecisionOutcomeKind" AS ENUM ('PAID', 'LATE', 'RETURNED_DEBIT_ORDER', 'EVER_30_DPD', 'EVER_60_DPD', 'EVER_90_DPD', 'DEFAULTED_STATUS', 'CURED', 'SETTLED', 'WRITTEN_OFF', 'TAKEN_UP');

-- CreateEnum
CREATE TYPE "DecisionOutcomeState" AS ENUM ('OBSERVED', 'PENDING', 'UNOBSERVABLE');

-- CreateTable
CREATE TABLE "DecisionOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "decisionRecordId" TEXT NOT NULL,
    "outcomeKind" "DecisionOutcomeKind" NOT NULL,
    "window" TEXT NOT NULL,
    "state" "DecisionOutcomeState" NOT NULL,
    "value" BOOLEAN,
    "amountCents" INTEGER,
    "reasonCode" TEXT,
    "sourceSystem" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "definitionVersion" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionOutcome_tenantId_outcomeKind_window_state_idx" ON "DecisionOutcome"("tenantId", "outcomeKind", "window", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionOutcome_decisionRecordId_outcomeKind_window_sourceS_key" ON "DecisionOutcome"("decisionRecordId", "outcomeKind", "window", "sourceSystem", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "CreditDecisionRecord_tenantId_id_key" ON "CreditDecisionRecord"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_tenantId_decisionRecordId_fkey" FOREIGN KEY ("tenantId", "decisionRecordId") REFERENCES "CreditDecisionRecord"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written ────────────────────────────────────────────────────────────

-- Only the two sources DESIGN.md §4 names; nothing names a source lender.
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_source_system"
  CHECK ("sourceSystem" IN ('credaflow', 'external_extract') AND char_length("sourceRef") > 0);

ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_window"
  CHECK ("window" ~ '^(3M|6M|12M|TERM_30D|OFFER|INSTALMENT:[1-9][0-9]{0,3})$');

-- A value and the moment it was observed exist exactly when the outcome is
-- OBSERVED: a PENDING or UNOBSERVABLE row can never be read as a good outcome.
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_value_when_observed"
  CHECK (("state" = 'OBSERVED') = ("value" IS NOT NULL)
    AND ("state" = 'OBSERVED') = ("observedAt" IS NOT NULL));

-- Tenant row-level security, as for every tenant table (20261014130000_tenant_rls).
ALTER TABLE "DecisionOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DecisionOutcome" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DecisionOutcome" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
