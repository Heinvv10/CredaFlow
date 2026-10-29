-- Maker-checker change requests and business-configurable decisioning (A4).
-- Additive: new tables, nullable LoanApplication.risk*/humanReviewRequestedAt columns and User.isSystem (default false).
-- No existing row is touched. The one replaced function is guardLoanApplicationSegregationOfDuties (adds a check).

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
ALTER TABLE "LoanApplication" ADD COLUMN     "humanReviewRequestedAt" TIMESTAMP(3),
ADD COLUMN     "riskGrade" TEXT,
ADD COLUMN     "riskGradeRank" INTEGER,
ADD COLUMN     "riskGradeVersionId" TEXT,
ADD COLUMN     "riskGradedAt" TIMESTAMP(3),
ADD COLUMN     "riskPricingTier" TEXT,
ADD COLUMN     "riskScore" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

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
    "repaymentMethod" "LoanRepaymentMethod" NOT NULL DEFAULT 'EFT',
    "challengerVersionId" TEXT,
    "challengerPercent" INTEGER NOT NULL DEFAULT 0,
    "s71SignedOffAt" TIMESTAMP(3),
    "s71SignedOffById" TEXT,
    "automatedDeclineNotice" TEXT,
    "changeRequestId" TEXT NOT NULL,
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
    "submissionLatencyMs" INTEGER,
    "noticeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoDecisionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoDecisionDue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "chargedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutoDecisionDue_pkey" PRIMARY KEY ("id")
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
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "baseRef" TEXT,
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
CREATE INDEX "AutoDecisionDue_tenantId_completedAt_createdAt_idx" ON "AutoDecisionDue"("tenantId", "completedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AutoDecisionDue_tenantId_clientId_chargedAt_idx" ON "AutoDecisionDue"("tenantId", "clientId", "chargedAt");

-- CreateIndex
CREATE INDEX "AutoDecisionDue_tenantId_ip_chargedAt_idx" ON "AutoDecisionDue"("tenantId", "ip", "chargedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutoDecisionDue_tenantId_applicationId_key" ON "AutoDecisionDue"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoDecisionDue_tenantId_id_key" ON "AutoDecisionDue"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_kind_status_idx" ON "ChangeRequest"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_tenantId_id_key" ON "ChangeRequest"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_riskGradeVersionId_fkey" FOREIGN KEY ("tenantId", "riskGradeVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRuleSetVersion" ADD CONSTRAINT "DecisionRuleSetVersion_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "LoanProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_tenantId_challengerVersionId_fkey" FOREIGN KEY ("tenantId", "challengerVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_tenantId_ruleSetVersionId_fkey" FOREIGN KEY ("tenantId", "ruleSetVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutoDecisionDue" ADD CONSTRAINT "AutoDecisionDue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
    WHEN 'DRAFT>DRAFT' THEN ARRAY['title', 'payload', 'payloadVersion', 'updatedAt']
    WHEN 'DRAFT>SUBMITTED' THEN ARRAY['status', 'submittedAt', 'baseRef', 'updatedAt']
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
-- The lender's legal sign-off of automated declines is recorded with who gave it, and needs the approved client notice.
ALTER TABLE "DecisionEngineConfig" ADD CONSTRAINT "DecisionEngineConfig_s71_signoff" CHECK (
  ("s71SignedOffAt" IS NULL) = ("s71SignedOffById" IS NULL)
  AND ("s71SignedOffAt" IS NULL OR ("automatedDeclineNotice" IS NOT NULL AND length(btrim("automatedDeclineNotice")) >= 20))
  AND ("automatedDeclineNotice" IS NULL OR length("automatedDeclineNotice") <= 2000)
);

-- The settings exist only because an approved DECISION_ENGINE_CONFIG request of this lender wrote them, and
-- each change is a new request: the row cannot be edited under the request that last wrote it.
CREATE OR REPLACE FUNCTION public."guardDecisionEngineConfig"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  req RECORD;
  carried TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."changeRequestId" IS NOT DISTINCT FROM OLD."changeRequestId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Decision engine settings change only with a newly approved DECISION_ENGINE_CONFIG change request';
  END IF;
  SELECT c."payload", c."checkerId" INTO req FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId"
      AND c."kind" = 'DECISION_ENGINE_CONFIG' AND c."status" = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Decision engine settings are written only by an approved DECISION_ENGINE_CONFIG change request';
  END IF;
  -- What was approved is what is written: the mode, repayment method, challenger share and the s71 sign-off.
  IF NEW."mode"::TEXT IS DISTINCT FROM req."payload" ->> 'mode'
    OR NEW."repaymentMethod"::TEXT IS DISTINCT FROM req."payload" ->> 'repaymentMethod'
    OR NEW."challengerPercent" IS DISTINCT FROM (req."payload" ->> 'challengerPercent')::INTEGER
    OR (NEW."s71SignedOffAt" IS NOT NULL) IS DISTINCT FROM COALESCE((req."payload" ->> 's71SignOff')::BOOLEAN, false)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Decision engine settings must match the approved change request''s payload';
  END IF;
  -- The sign-off is given by the checker who approved it, or carried over unchanged. An upsert reaches this as an
  -- INSERT first (ON CONFLICT), so the existing row's value is read for that case.
  IF TG_OP = 'UPDATE' THEN
    carried := OLD."s71SignedOffById";
  ELSE
    SELECT e."s71SignedOffById" INTO carried FROM "DecisionEngineConfig" e WHERE e."tenantId" = NEW."tenantId";
  END IF;
  IF NEW."s71SignedOffById" IS NOT NULL AND NEW."s71SignedOffById" IS DISTINCT FROM req."checkerId"
    AND NEW."s71SignedOffById" IS DISTINCT FROM carried
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The s71 sign-off is recorded against the checker who approved the change';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "DecisionEngineConfig_guard" BEFORE INSERT OR UPDATE ON "DecisionEngineConfig"
  FOR EACH ROW EXECUTE FUNCTION public."guardDecisionEngineConfig"();

-- AutoDecisionRun -------------------------------------------------------------

ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_reason_codes_array" CHECK (jsonb_typeof("reasonCodes") = 'array');
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_latency" CHECK ("latencyMs" >= 0);
-- A run exists only for a mode that evaluates; SHADOW acts on nothing, LIVE acts.
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_mode_execution" CHECK (CASE "mode"
  WHEN 'SHADOW' THEN "execution" = 'NOT_ACTED'
  WHEN 'LIVE' THEN "execution" <> 'NOT_ACTED'
  ELSE false
END);
-- What was done follows from the verdict; REFERRED is any verdict that could not be acted on (a refer, a hard gate refusing an approve, a decline held for the s71 sign-off).
ALTER TABLE "AutoDecisionRun" ADD CONSTRAINT "AutoDecisionRun_execution_follows_verdict" CHECK (CASE "execution"
  WHEN 'APPROVED' THEN "verdict" = 'APPROVE'
  WHEN 'DECLINED' THEN "verdict" = 'DECLINE'
  WHEN 'REFERRED' THEN true
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
  AND ("riskGrade" IS NULL) = ("riskGradeVersionId" IS NULL)
  AND ("riskGrade" IS NULL) = ("riskGradeRank" IS NULL)
  AND ("riskGrade" IS NULL OR "riskGrade" ~ '^[A-Z0-9+-]{1,4}$')
  AND ("riskScore" IS NULL OR "riskGrade" IS NOT NULL)
  AND ("riskPricingTier" IS NULL OR "riskGrade" IS NOT NULL)
);

-- The per-lender automated decisioning actor never signs in: inactive, no usable password, one per lender.
ALTER TABLE "User" ADD CONSTRAINT "User_system_no_login" CHECK (NOT "isSystem" OR ("active" = false AND "password" = '!' AND "role" = 'LOAN_ADMIN' AND "tenantId" IS NOT NULL));
CREATE UNIQUE INDEX "User_one_system_per_tenant" ON "User" ("tenantId") WHERE "isSystem";

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

-- AutoDecisionDue ---------------------------------------------------------------

ALTER TABLE "AutoDecisionDue" ADD CONSTRAINT "AutoDecisionDue_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "AutoDecisionDue" ADD CONSTRAINT "AutoDecisionDue_ip" CHECK ("ip" IS NULL OR length("ip") <= 64);
-- A finished entry says how it ended; an open one has no outcome.
ALTER TABLE "AutoDecisionDue" ADD CONSTRAINT "AutoDecisionDue_outcome" CHECK (("completedAt" IS NULL) = ("outcome" IS NULL));

ALTER TABLE "AutoDecisionDue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutoDecisionDue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AutoDecisionDue" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- Segregation of duties for a system approval (lib/decisioning/): the engine approved it, so the people whose
-- attestations the approval rested on (the reckless-lending assessor, the income verifier, the bureau-override
-- giver) cannot also disburse it. guardLoanApplicationSegregationOfDuties as of 20261016200200, plus that check.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationSegregationOfDuties"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  disbursing BOOLEAN;
  countersigning BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."disbursedById" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'The staff member who disbursed an application is recorded only with the DISBURSED transition';
    END IF;
    disbursing := NEW."status" = 'DISBURSED'::"AppStatus";
    countersigning := NEW."agreementCountersignedAt" IS NOT NULL;
  ELSE
    disbursing := NEW."status" = 'DISBURSED'::"AppStatus"
      AND OLD."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus";
    countersigning := OLD."agreementCountersignedAt" IS NULL
      AND NEW."agreementCountersignedAt" IS NOT NULL;
    IF NEW."disbursedById" IS DISTINCT FROM OLD."disbursedById" AND NOT disbursing THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'The staff member who disbursed an application is recorded only with the DISBURSED transition';
    END IF;
  END IF;

  IF disbursing AND NEW."disbursedById" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u."id" = NEW."disbursedById"
      AND u."tenantId" = NEW."tenantId"
      AND u."active" = TRUE
      AND u."role" IN (
        'LOAN_ADMIN'::"UserRole",
        'BRANCH_MANAGER'::"UserRole",
        'ADMIN'::"UserRole",
        'SUPER_ADMIN'::"UserRole"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A disbursement is recorded against an active staff member of the application tenant who may disburse';
  END IF;

  IF NEW."entityId" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."id" AND d."tenantId" = NEW."tenantId"
  ) THEN
    RETURN NEW;
  END IF;

  IF disbursing AND "tenantRequiresSegregationOfDuties"(NEW."tenantId") THEN
    IF NEW."disbursedById" IS NULL OR LENGTH(BTRIM(NEW."disbursedById")) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: a disbursement must record the staff member who made it';
    END IF;
    IF NEW."disbursedById" = NEW."approvedById" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: the staff member who approved an application cannot disburse it';
    END IF;
    IF NEW."disbursedById" IN (NEW."recklessLendingAssessedById", NEW."incomeVerifiedById", NEW."bureauOverrideById")
      AND EXISTS (SELECT 1 FROM "User" a WHERE a."id" = NEW."approvedById" AND a."tenantId" = NEW."tenantId" AND a."isSystem")
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: the engine approved this application on the attestation of the staff member who would disburse it';
    END IF;
  END IF;

  IF countersigning
    AND NEW."agreementSignedMethod" = 'branch'
    AND NEW."agreementSignedByUserId" = NEW."agreementCountersignedById"
    AND "tenantRequiresSegregationOfDuties"(NEW."tenantId")
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Segregation of duties: the staff witness of the in-branch signature cannot countersign for the provider';
  END IF;

  RETURN NEW;
END;
$function$;
