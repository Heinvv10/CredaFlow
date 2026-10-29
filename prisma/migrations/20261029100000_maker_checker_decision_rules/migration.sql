-- Maker-checker change requests and business-configurable decisioning (A4).
-- Additive: new tables, two enum-backed config columns' worth of state, and nullable
-- LoanApplication.riskGrade/riskScore/riskGradedAt. No existing row is touched.

-- CreateEnum
CREATE TYPE "DecisionEngineMode" AS ENUM ('OFF', 'SHADOW', 'LIVE');

-- CreateEnum
CREATE TYPE "AutoDecisionVerdict" AS ENUM ('APPROVE', 'DECLINE', 'REFER');

-- CreateEnum
CREATE TYPE "AutoDecisionRole" AS ENUM ('CHAMPION', 'CHALLENGER');

-- CreateEnum
CREATE TYPE "AutoDecisionExecution" AS ENUM ('APPROVED', 'DECLINED', 'REFERRED', 'NOT_ACTED');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "riskGrade" TEXT,
ADD COLUMN     "riskGradedAt" TIMESTAMP(3),
ADD COLUMN     "riskScore" INTEGER;

-- CreateTable
CREATE TABLE "DecisionRuleSetVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "productId" TEXT,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "scorecard" JSONB,
    "effectiveFrom" DATE NOT NULL,
    "challengerOnly" BOOLEAN NOT NULL DEFAULT false,
    "changeRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRuleSetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionEngineConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" "DecisionEngineMode" NOT NULL DEFAULT 'OFF',
    "channels" TEXT[],
    "productIds" TEXT[],
    "delegateUserId" TEXT,
    "repaymentMethod" "LoanRepaymentMethod" NOT NULL DEFAULT 'EFT',
    "challengerVersionId" TEXT,
    "challengerPercent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionEngineConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoDecisionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ruleSetVersionId" TEXT NOT NULL,
    "role" "AutoDecisionRole" NOT NULL,
    "mode" "DecisionEngineMode" NOT NULL,
    "trigger" TEXT NOT NULL,
    "verdict" "AutoDecisionVerdict" NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "riskGrade" TEXT,
    "score" INTEGER,
    "execution" "AutoDecisionExecution" NOT NULL,
    "executionNote" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoDecisionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "makerId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "checkerId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionRuleSetVersion_tenantId_scopeKey_effectiveFrom_idx" ON "DecisionRuleSetVersion"("tenantId", "scopeKey", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRuleSetVersion_tenantId_id_key" ON "DecisionRuleSetVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRuleSetVersion_tenantId_scopeKey_version_key" ON "DecisionRuleSetVersion"("tenantId", "scopeKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRuleSetVersion_tenantId_changeRequestId_key" ON "DecisionRuleSetVersion"("tenantId", "changeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionEngineConfig_tenantId_key" ON "DecisionEngineConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionEngineConfig_tenantId_id_key" ON "DecisionEngineConfig"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AutoDecisionRun_tenantId_applicationId_idx" ON "AutoDecisionRun"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "AutoDecisionRun_tenantId_createdAt_idx" ON "AutoDecisionRun"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutoDecisionRun_tenantId_id_key" ON "AutoDecisionRun"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_kind_status_idx" ON "ChangeRequest"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_tenantId_id_key" ON "ChangeRequest"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "LoanProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_tenantId_delegateUserId_fkey" FOREIGN KEY ("tenantId", "delegateUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_tenantId_challengerVersionId_fkey" FOREIGN KEY ("tenantId", "challengerVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_tenantId_ruleSetVersionId_fkey" FOREIGN KEY ("tenantId", "ruleSetVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_makerId_fkey" FOREIGN KEY ("tenantId", "makerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_checkerId_fkey" FOREIGN KEY ("tenantId", "checkerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ---------------------------------------------------------------------------
-- Hand-written: maker-checker change requests and business-configurable
-- decisioning (lib/maker-checker/, lib/decisioning/). Every refusal is
-- SQLSTATE 23514. Tests: lib/maker-checker/*.integration.test.ts and
-- lib/decisioning/*.integration.test.ts (RUN_MAKER_CHECKER_IT).
-- ---------------------------------------------------------------------------

-- ChangeRequest ---------------------------------------------------------------

ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_kind" CHECK ("kind" ~ '^[A-Z][A-Z0-9_]{2,59}$');
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_title" CHECK ("title" = btrim("title") AND length("title") BETWEEN 1 AND 200);
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_payload_object" CHECK (jsonb_typeof("payload") = 'object');
-- Four-eyes: whoever approves or rejects is not whoever drafted it.
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_four_eyes" CHECK ("checkerId" IS NULL OR "checkerId" <> "makerId");
-- Who moved a request, and when, are set exactly for the statuses it reached.
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_status_shape" CHECK (CASE "status"
  WHEN 'DRAFT' THEN num_nonnulls("submittedAt", "checkerId", "decidedAt", "appliedAt") = 0
  WHEN 'SUBMITTED' THEN "submittedAt" IS NOT NULL AND num_nonnulls("checkerId", "decidedAt", "appliedAt") = 0
  WHEN 'APPROVED' THEN num_nonnulls("submittedAt", "checkerId", "decidedAt", "appliedAt") = 4
  WHEN 'REJECTED' THEN num_nonnulls("submittedAt", "checkerId", "decidedAt") = 3 AND "appliedAt" IS NULL
    AND "decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 1
  WHEN 'WITHDRAWN' THEN "decidedAt" IS NOT NULL AND num_nonnulls("checkerId", "appliedAt") = 0
END);

-- A request moves DRAFT -> SUBMITTED | WITHDRAWN and SUBMITTED -> APPROVED |
-- REJECTED | WITHDRAWN, and is never deleted. Only a draft's title and payload
-- change; from submission the payload the checker read is the payload applied.
CREATE OR REPLACE FUNCTION public."guardChangeRequest"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  allowed TEXT[];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A change request is never deleted: withdraw it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A change request is created as a DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD."status"::TEXT || '>' || NEW."status"::TEXT
    WHEN 'DRAFT>DRAFT' THEN ARRAY['title', 'payload', 'updatedAt']
    WHEN 'DRAFT>SUBMITTED' THEN ARRAY['status', 'submittedAt', 'updatedAt']
    WHEN 'DRAFT>WITHDRAWN' THEN ARRAY['status', 'decidedAt', 'decisionNote', 'updatedAt']
    WHEN 'SUBMITTED>APPROVED' THEN ARRAY['status', 'checkerId', 'decidedAt', 'decisionNote', 'appliedAt', 'updatedAt']
    WHEN 'SUBMITTED>REJECTED' THEN ARRAY['status', 'checkerId', 'decidedAt', 'decisionNote', 'updatedAt']
    WHEN 'SUBMITTED>WITHDRAWN' THEN ARRAY['status', 'decidedAt', 'decisionNote', 'updatedAt']
  END;
  IF allowed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A change request moves only DRAFT to SUBMITTED or WITHDRAWN, and SUBMITTED to APPROVED, REJECTED or WITHDRAWN: not %s to %s', OLD."status", NEW."status");
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A change request changes only its title and payload while a draft, and otherwise only what its move sets: its kind, maker and payload never change after submission';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ChangeRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION public."guardChangeRequest"();
CREATE TRIGGER "ChangeRequest_no_truncate" BEFORE TRUNCATE ON "ChangeRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardChangeRequest"();

-- DecisionRuleSetVersion ------------------------------------------------------

ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_scope" CHECK ("scopeKey" = COALESCE("productId", 'ALL'));
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_version" CHECK ("version" >= 1);
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_name" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 100);
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_rules_array" CHECK (jsonb_typeof("rules") = 'array');
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_scorecard_object" CHECK ("scorecard" IS NULL OR jsonb_typeof("scorecard") = 'object');

-- A version exists only because an approved request of its kind made it, and
-- never changes or goes away: a correction is a new version.
CREATE OR REPLACE FUNCTION public."guardDecisionRuleSetVersion"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A decision rule set version never changes or goes away: approve a new version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChangeRequest" c
      WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId"
        AND c."kind" = 'DECISION_RULE_SET' AND c."status" = 'APPROVED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A decision rule set version is created only by an approved DECISION_RULE_SET change request';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "DecisionRuleSetVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DecisionRuleSetVersion"
  FOR EACH ROW EXECUTE FUNCTION public."guardDecisionRuleSetVersion"();
CREATE TRIGGER "DecisionRuleSetVersion_no_truncate" BEFORE TRUNCATE ON "DecisionRuleSetVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardDecisionRuleSetVersion"();

-- DecisionEngineConfig --------------------------------------------------------

ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_challenger_percent" CHECK ("challengerPercent" BETWEEN 0 AND 50);
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_challenger_named" CHECK ("challengerPercent" = 0 OR "challengerVersionId" IS NOT NULL);
-- Live decisions are booked under a named staff user.
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_live_has_delegate" CHECK ("mode" <> 'LIVE' OR "delegateUserId" IS NOT NULL);

-- The delegate is an active staff user who could approve by hand (LOAN_ADMIN or above).
CREATE OR REPLACE FUNCTION public."guardDecisionEngineDelegate"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."delegateUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u
      WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."delegateUserId" AND u."active"
        AND u."role" IN ('LOAN_ADMIN', 'BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The decision engine delegate is an active LOAN_ADMIN or above';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "DecisionEngineConfig_delegate" BEFORE INSERT OR UPDATE OF "delegateUserId" ON "DecisionEngineConfig"
  FOR EACH ROW EXECUTE FUNCTION public."guardDecisionEngineDelegate"();

-- AutoDecisionRun -------------------------------------------------------------

ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_reason_codes_array" CHECK (jsonb_typeof("reasonCodes") = 'array');
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_latency" CHECK ("latencyMs" >= 0);
-- A run exists only for a mode that evaluates; SHADOW acts on nothing, LIVE acts.
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_mode_execution" CHECK (CASE "mode"
  WHEN 'SHADOW' THEN "execution" = 'NOT_ACTED'
  WHEN 'LIVE' THEN "execution" <> 'NOT_ACTED'
  ELSE false
END);
-- What was done follows from the verdict; a REFERRED APPROVE is a hard gate of the staff path refusing it.
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_execution_follows_verdict" CHECK (CASE "execution"
  WHEN 'APPROVED' THEN "verdict" = 'APPROVE'
  WHEN 'DECLINED' THEN "verdict" = 'DECLINE'
  WHEN 'REFERRED' THEN "verdict" IN ('REFER', 'APPROVE')
  ELSE true
END);

CREATE OR REPLACE FUNCTION public."guardAutoDecisionRun"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An automatic decision run is a record: it is never changed or deleted';
END;
$function$;
CREATE TRIGGER "AutoDecisionRun_guard" BEFORE UPDATE OR DELETE ON "AutoDecisionRun"
  FOR EACH ROW EXECUTE FUNCTION public."guardAutoDecisionRun"();
CREATE TRIGGER "AutoDecisionRun_no_truncate" BEFORE TRUNCATE ON "AutoDecisionRun"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardAutoDecisionRun"();

-- LoanApplication risk grade --------------------------------------------------

ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_risk_grade_shape" CHECK (
  ("riskGrade" IS NULL) = ("riskGradedAt" IS NULL)
  AND ("riskGrade" IS NULL OR "riskGrade" ~ '^[A-Z0-9+-]{1,4}$')
  AND ("riskScore" IS NULL OR "riskGrade" IS NOT NULL)
);

-- Tenant isolation (as 20261015130000_tenant_rls_new_scoped_models) ----------

ALTER TABLE "ChangeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChangeRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ChangeRequest" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DecisionRuleSetVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DecisionRuleSetVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DecisionRuleSetVersion" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DecisionEngineConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DecisionEngineConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DecisionEngineConfig" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AutoDecisionRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutoDecisionRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AutoDecisionRun" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
