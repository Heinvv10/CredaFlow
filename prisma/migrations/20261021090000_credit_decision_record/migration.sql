-- Learning loop, PR A: the decision log (docs/learning-loop/DESIGN.md).
-- Additive: one new table and three enums; nothing existing changes. The
-- code that writes it (lib/learning-loop/) ships in the same release; the
-- CHECKs and the trigger below refuse only rows that code never writes.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TABLE "CreditDecisionRecord";
--   DROP FUNCTION public."guardCreditDecisionRecord"();
--   DROP TYPE "DecisionRecordKind";
--   DROP TYPE "DecisionRecommendation";
--   DROP TYPE "DecisionActorType";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021090000_credit_decision_record';
--   COMMIT;
-- Dropping the table drops its triggers, constraints and policy with it, and
-- every decision record: export them first on a database that holds real ones.

-- CreateEnum
CREATE TYPE "DecisionRecordKind" AS ENUM ('CREDIT_DECISION', 'OFFER', 'COLLECTION_ACTION');

-- CreateEnum
CREATE TYPE "DecisionRecommendation" AS ENUM ('PASS', 'BLOCK', 'REFER', 'NONE');

-- CreateEnum
CREATE TYPE "DecisionActorType" AS ENUM ('STAFF', 'SYSTEM', 'CLIENT');

-- CreateTable
CREATE TABLE "CreditDecisionRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "DecisionRecordKind" NOT NULL,
    "decision" TEXT NOT NULL,
    "recommendation" "DecisionRecommendation" NOT NULL,
    "overridden" BOOLEAN NOT NULL,
    "overrideReason" TEXT,
    "actorType" "DecisionActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "applicationId" TEXT,
    "loanId" TEXT,
    "clientId" TEXT,
    "sourceEntityType" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "policyHash" CHAR(64) NOT NULL,
    "modelVersion" TEXT,
    "predictedProbability" DECIMAL(6,5),
    "inputsSnapshot" JSONB NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "inputsHash" CHAR(64) NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditDecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditDecisionRecord_tenantId_applicationId_idx" ON "CreditDecisionRecord"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "CreditDecisionRecord_tenantId_loanId_idx" ON "CreditDecisionRecord"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "CreditDecisionRecord_tenantId_kind_decidedAt_idx" ON "CreditDecisionRecord"("tenantId", "kind", "decidedAt");

-- AddForeignKey
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written ────────────────────────────────────────────────────────────

-- Hashes are lower-case sha256 hex.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_hashes_sha256"
  CHECK ("inputsHash" ~ '^[0-9a-f]{64}$' AND "policyHash" ~ '^[0-9a-f]{64}$');

-- A decision is an upper-case code (lib/learning-loop/decision-log.ts).
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_decision_code"
  CHECK ("decision" ~ '^[A-Z][A-Z_]{1,39}$');

-- A probability, when a model produced one, is in [0, 1].
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_probability_range"
  CHECK ("predictedProbability" IS NULL OR ("predictedProbability" >= 0 AND "predictedProbability" <= 1));

-- Going against a gate needs a written reason (the shortest one the routes
-- accept is the bureau override's 10 characters), and a reason is stored
-- only for an override.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_override_reason"
  CHECK (("overridden" AND "overrideReason" IS NOT NULL AND char_length(btrim("overrideReason")) >= 10)
    OR (NOT "overridden" AND "overrideReason" IS NULL));

-- A staff decision names the person; an automated one names nobody.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_actor"
  CHECK (("actorType" = 'STAFF' AND "actorUserId" IS NOT NULL)
    OR ("actorType" = 'SYSTEM' AND "actorUserId" IS NULL)
    OR "actorType" = 'CLIENT');

-- A decision is about someone: an application, a loan or a client.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject"
  CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL);

ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_json_objects"
  CHECK (jsonb_typeof("inputsSnapshot") = 'object' AND jsonb_typeof("evidenceRefs") = 'object');

-- Append-only: no UPDATE, DELETE or TRUNCATE (as LoanArrearsSnapshot,
-- 20261017090000_loan_arrears_snapshot).
CREATE OR REPLACE FUNCTION public."guardCreditDecisionRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'The credit decision log is append-only';
END;
$function$;

CREATE TRIGGER "CreditDecisionRecord_append_only"
  BEFORE UPDATE OR DELETE ON "CreditDecisionRecord"
  FOR EACH ROW EXECUTE FUNCTION public."guardCreditDecisionRecord"();
CREATE TRIGGER "CreditDecisionRecord_guard_truncate"
  BEFORE TRUNCATE ON "CreditDecisionRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardCreditDecisionRecord"();

-- Tenant row-level security, as for every tenant table (20261014130000_tenant_rls).
ALTER TABLE "CreditDecisionRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditDecisionRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CreditDecisionRecord" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
