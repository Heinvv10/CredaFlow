-- Approval matrix (lib/approval/): versioned multi-level approval, delegated authority, escalation and
-- credit-committee decisions. Additive: new tables, enums and triggers; no existing row is touched. A lender
-- with no enabled matrix has no ApprovalCase, and the application trigger then changes nothing.

-- CreateEnum
CREATE TYPE "ApprovalCaseStatus" AS ENUM ('OPEN', 'APPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApprovalStepVia" AS ENUM ('ROLE', 'DELEGATION');

-- CreateEnum
CREATE TYPE "CommitteeDecisionKind" AS ENUM ('APPROVED', 'DECLINED', 'DEFERRED');

-- CreateTable
CREATE TABLE "ApprovalMatrixVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "levels" JSONB NOT NULL,
    "rules" JSONB NOT NULL,
    "defaultRequiredLevels" INTEGER NOT NULL,
    "changeRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalMatrixVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "matrixVersionId" TEXT,
    "status" "ApprovalCaseStatus" NOT NULL DEFAULT 'OPEN',
    "requiredLevels" INTEGER,
    "levelsSnapshot" JSONB,
    "matchedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingLevel" INTEGER NOT NULL DEFAULT 1,
    "levelStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "escalationCount" INTEGER NOT NULL DEFAULT 0,
    "lastEscalatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "approverId" TEXT NOT NULL,
    "via" "ApprovalStepVia" NOT NULL,
    "delegationId" TEXT,
    "note" TEXT,
    "conditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalEscalation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromLevel" INTEGER NOT NULL,
    "toLevel" INTEGER NOT NULL,
    "notifiedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "delegatorId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "maxAmountCents" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditCommitteeDecision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "decision" "CommitteeDecisionKind" NOT NULL,
    "meetingDate" DATE NOT NULL,
    "attendees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conditions" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "delegationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditCommitteeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalMatrixVersion_tenantId_effectiveFrom_idx" ON "ApprovalMatrixVersion"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalMatrixVersion_tenantId_version_key" ON "ApprovalMatrixVersion"("tenantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalMatrixVersion_tenantId_id_key" ON "ApprovalMatrixVersion"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ApprovalCase_tenantId_applicationId_idx" ON "ApprovalCase"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "ApprovalCase_tenantId_status_dueAt_idx" ON "ApprovalCase"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalCase_tenantId_id_key" ON "ApprovalCase"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ApprovalStep_tenantId_applicationId_idx" ON "ApprovalStep"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_caseId_level_key" ON "ApprovalStep"("caseId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_caseId_approverId_key" ON "ApprovalStep"("caseId", "approverId");

-- CreateIndex
CREATE INDEX "ApprovalEscalation_tenantId_caseId_idx" ON "ApprovalEscalation"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_tenantId_delegateId_validTo_idx" ON "ApprovalDelegation"("tenantId", "delegateId", "validTo");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_tenantId_delegatorId_idx" ON "ApprovalDelegation"("tenantId", "delegatorId");

-- CreateIndex
CREATE INDEX "CreditCommitteeDecision_tenantId_applicationId_idx" ON "CreditCommitteeDecision"("tenantId", "applicationId");

-- AddForeignKey
ALTER TABLE "ApprovalMatrixVersion" ADD CONSTRAINT "ApprovalMatrixVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalCase" ADD CONSTRAINT "ApprovalCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalCase" ADD CONSTRAINT "ApprovalCase_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalCase" ADD CONSTRAINT "ApprovalCase_tenantId_matrixVersionId_fkey" FOREIGN KEY ("tenantId", "matrixVersionId") REFERENCES "ApprovalMatrixVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "ApprovalCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_tenantId_approverId_fkey" FOREIGN KEY ("tenantId", "approverId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalEscalation" ADD CONSTRAINT "ApprovalEscalation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalEscalation" ADD CONSTRAINT "ApprovalEscalation_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "ApprovalCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_tenantId_delegatorId_fkey" FOREIGN KEY ("tenantId", "delegatorId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_tenantId_delegateId_fkey" FOREIGN KEY ("tenantId", "delegateId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditCommitteeDecision" ADD CONSTRAINT "CreditCommitteeDecision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditCommitteeDecision" ADD CONSTRAINT "CreditCommitteeDecision_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Constraints --------------------------------------------------------------------------------------------

CREATE UNIQUE INDEX "ApprovalCase_one_open_per_application" ON "ApprovalCase"("tenantId", "applicationId") WHERE "status" = 'OPEN';

ALTER TABLE "ApprovalMatrixVersion" ADD CONSTRAINT "ApprovalMatrixVersion_shape" CHECK (
  "version" >= 1 AND "defaultRequiredLevels" BETWEEN 0 AND 5
  AND jsonb_typeof("levels") = 'array' AND jsonb_typeof("rules") = 'array'
  AND jsonb_array_length("levels") BETWEEN 1 AND 5
  AND length("name") BETWEEN 1 AND 80
);
ALTER TABLE "ApprovalCase" ADD CONSTRAINT "ApprovalCase_shape" CHECK (
  ("requiredLevels" IS NULL OR "requiredLevels" BETWEEN 0 AND 5)
  AND "pendingLevel" BETWEEN 1 AND 6
  AND "escalationCount" >= 0
  AND (("status" = 'OPEN') = ("completedAt" IS NULL))
  AND ("requiredLevels" IS NULL) = ("levelsSnapshot" IS NULL)
);
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_shape" CHECK (
  "level" BETWEEN 1 AND 5
  AND (("via" = 'DELEGATION') = ("delegationId" IS NOT NULL))
  AND ("conditions" IS NULL OR jsonb_typeof("conditions") = 'array')
);
ALTER TABLE "ApprovalEscalation" ADD CONSTRAINT "ApprovalEscalation_shape" CHECK ("fromLevel" >= 1 AND "toLevel" > "fromLevel");
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_shape" CHECK (
  "level" BETWEEN 1 AND 5
  AND "maxAmountCents" > 0
  AND "validTo" > "validFrom"
  AND "validTo" - "validFrom" <= interval '90 days'
  AND "delegatorId" <> "delegateId"
  AND "createdById" <> "delegateId"
  AND length(btrim("reason")) >= 10
  AND (("revokedAt" IS NULL) = ("revokedById" IS NULL))
);
ALTER TABLE "CreditCommitteeDecision" ADD CONSTRAINT "CreditCommitteeDecision_shape" CHECK (
  "level" BETWEEN 1 AND 5
  AND jsonb_typeof("conditions") = 'array'
  AND length(btrim("rationale")) >= 10
  AND ("decision" = 'APPROVED' OR jsonb_array_length("conditions") = 0)
);

-- Append-only tables ------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public."guardApprovalAppendOnly"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = TG_TABLE_NAME || ' is append-only: a record of an approval never changes or goes away';
END;
$function$;
CREATE TRIGGER "ApprovalEscalation_append_only" BEFORE UPDATE OR DELETE ON "ApprovalEscalation" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "CreditCommitteeDecision_append_only" BEFORE UPDATE OR DELETE ON "CreditCommitteeDecision" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "ApprovalStep_append_only" BEFORE UPDATE OR DELETE ON "ApprovalStep" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "ApprovalEscalation_no_truncate" BEFORE TRUNCATE ON "ApprovalEscalation" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "CreditCommitteeDecision_no_truncate" BEFORE TRUNCATE ON "CreditCommitteeDecision" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "ApprovalStep_no_truncate" BEFORE TRUNCATE ON "ApprovalStep" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalAppendOnly"();

-- A matrix version exists only because an approved APPROVAL_MATRIX request made it, holds exactly what was approved,
-- and never changes: a correction is a new version.
CREATE OR REPLACE FUNCTION public."guardApprovalMatrixVersion"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  req RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval matrix version never changes or goes away: approve a new version';
  END IF;
  SELECT c."payload" INTO req FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'APPROVAL_MATRIX' AND c."status" = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval matrix version is created only by an approved APPROVAL_MATRIX change request';
  END IF;
  IF NEW."levels" IS DISTINCT FROM req."payload" -> 'levels'
    OR NEW."rules" IS DISTINCT FROM req."payload" -> 'rules'
    OR NEW."enabled" IS DISTINCT FROM (req."payload" ->> 'enabled')::BOOLEAN
    OR NEW."defaultRequiredLevels" IS DISTINCT FROM (req."payload" ->> 'defaultRequiredLevels')::INTEGER
    OR NEW."name" IS DISTINCT FROM req."payload" ->> 'name'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval matrix version must match the approved change request''s payload';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ApprovalMatrixVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ApprovalMatrixVersion" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalMatrixVersion"();
CREATE TRIGGER "ApprovalMatrixVersion_no_truncate" BEFORE TRUNCATE ON "ApprovalMatrixVersion" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalMatrixVersion"();

-- A case: its requirement is raised as the facts firm up, never lowered, and it never goes away; it ends OPEN -> APPROVED | CLOSED.
CREATE OR REPLACE FUNCTION public."approvalChainSatisfied"(case_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT c."requiredLevels" IS NOT NULL
    AND (SELECT count(DISTINCT s."level") FROM "ApprovalStep" s WHERE s."caseId" = c."id" AND s."level" BETWEEN 1 AND c."requiredLevels") = c."requiredLevels"
  FROM "ApprovalCase" c WHERE c."id" = case_id;
$function$;

CREATE OR REPLACE FUNCTION public."guardApprovalCase"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval case never goes away';
  END IF;
  IF NEW."applicationId" IS DISTINCT FROM OLD."applicationId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR (NEW."matrixVersionId" IS DISTINCT FROM OLD."matrixVersionId" AND OLD."requiredLevels" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval case''s application and matrix cannot be changed';
  END IF;
  IF OLD."requiredLevels" IS NOT NULL AND (NEW."requiredLevels" IS NULL OR NEW."requiredLevels" < OLD."requiredLevels" OR NEW."levelsSnapshot" IS DISTINCT FROM OLD."levelsSnapshot") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The number of levels an approval case needs is raised as the facts firm up, never lowered';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."requiredLevels" IS DISTINCT FROM OLD."requiredLevels" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A finished approval case''s requirement cannot change';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A finished approval case cannot be reopened';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" = 'OPEN' AND NOT "approvalChainSatisfied"(NEW."id") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval case is approved only when every required level has approved';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ApprovalCase_guard" BEFORE UPDATE OR DELETE ON "ApprovalCase" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalCase"();
CREATE TRIGGER "ApprovalCase_no_truncate" BEFORE TRUNCATE ON "ApprovalCase" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalAppendOnly"();

-- One person, one seat: why a candidate's principals (the person, and the delegator whose authority they act on) cannot take a seat on a
-- case, or NULL. A seat is taken by the maker, by each approver and the delegator behind a delegated approval, and by each committee
-- recorder (and the delegator behind them). `recorder_id` is the candidate when they record a committee decision: their own earlier
-- decisions do not conflict with them (one member may record several).
CREATE OR REPLACE FUNCTION public."approvalSeatTaken"(case_id TEXT, tenant_id TEXT, application_id TEXT, principals TEXT[], recorder_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $function$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."id" = application_id AND a."tenantId" = tenant_id AND COALESCE(a."inputStaffIds", '{}') && principals) THEN 'MAKER'
    WHEN EXISTS (
      SELECT 1 FROM "CreditCommitteeDecision" d LEFT JOIN "ApprovalDelegation" g ON g."id" = d."delegationId"
      WHERE d."caseId" = case_id AND d."recordedById" IS DISTINCT FROM recorder_id AND (d."recordedById" = ANY (principals) OR g."delegatorId" = ANY (principals))
    ) THEN 'RECORDED'
    WHEN EXISTS (
      SELECT 1 FROM "ApprovalStep" s LEFT JOIN "ApprovalDelegation" g ON g."id" = s."delegationId"
      WHERE s."caseId" = case_id AND (s."approverId" = ANY (principals) OR g."delegatorId" = ANY (principals))
    ) THEN 'SEATED'
    ELSE NULL
  END;
$function$;

-- A step: on an open case, in order, by an active person who is not the system user and did not capture the application
-- or change its inputs (the maker is never the approver). One person approves once per case, one approval per level.
-- A delegated step names a real delegation of that approver, in its window, unrevoked, reaching the level and the amount; and
-- one person never holds two seats: the delegator neither captured the application nor approved it, directly or through a delegate.
CREATE OR REPLACE FUNCTION public."guardApprovalStep"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  c RECORD;
  done INTEGER;
  dg RECORD;
  amount BIGINT;
  principals TEXT[];
  seat TEXT;
BEGIN
  SELECT * INTO c FROM "ApprovalCase" WHERE "id" = NEW."caseId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR c."status" <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded only on an open approval case';
  END IF;
  IF c."applicationId" IS DISTINCT FROM NEW."applicationId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval step names its case''s application';
  END IF;
  IF c."requiredLevels" IS NULL OR NEW."level" > c."requiredLevels" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded only at a level the case requires';
  END IF;
  SELECT count(*) INTO done FROM "ApprovalStep" WHERE "caseId" = NEW."caseId";
  IF NEW."level" <> done + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approvals are recorded in order, one level after another';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."approverId" AND u."tenantId" = NEW."tenantId" AND u."active" AND NOT u."isSystem") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded against an active staff member, never the automated decisioning account';
  END IF;
  principals := ARRAY[NEW."approverId"];
  IF NEW."via" = 'DELEGATION' THEN
    SELECT * INTO dg FROM "ApprovalDelegation" d WHERE d."id" = NEW."delegationId" AND d."tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A delegated approval names a delegation that exists';
    END IF;
    SELECT a."appliedAmount" INTO amount FROM "LoanApplication" a WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId";
    IF dg."delegateId" <> NEW."approverId" OR dg."level" < NEW."level" OR dg."validFrom" > now() OR dg."validTo" < now()
      OR (dg."revokedAt" IS NOT NULL AND dg."revokedAt" <= now()) OR amount > dg."maxAmountCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A delegated approval names a delegation to the approver that is in force and reaches this level and amount';
    END IF;
    principals := principals || dg."delegatorId";
  END IF;
  seat := public."approvalSeatTaken"(NEW."caseId", NEW."tenantId", NEW."applicationId", principals, NULL);
  IF seat = 'MAKER' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Maker-checker: the staff member who captured the application or changed its inputs cannot approve it';
  ELSIF seat = 'RECORDED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: whoever recorded the credit committee''s decision, or whose authority it was recorded on, cannot give the committee level''s approval';
  ELSIF seat IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: one person holds one seat on an application: an approver, or the authority a delegate acted on, appears once';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ApprovalStep_guard" BEFORE INSERT ON "ApprovalStep" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalStep"();

-- A committee decision: one person, one seat (see approvalSeatTaken): not from someone who made the application, approved a level, or whose
-- authority was used for a level, and when the recorder acts on a delegation it is a live one that reaches the level.
-- A decline is overturned (a later APPROVED) only by someone other than those who recorded a decline.
CREATE OR REPLACE FUNCTION public."guardCreditCommitteeDecision"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  dg RECORD;
  amount BIGINT;
  principals TEXT[];
  seat TEXT;
BEGIN
  IF NEW."decision" = 'APPROVED' AND EXISTS (SELECT 1 FROM "CreditCommitteeDecision" d WHERE d."caseId" = NEW."caseId" AND d."level" = NEW."level" AND d."decision" = 'DECLINED' AND d."recordedById" = NEW."recordedById") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A committee decline is overturned only by someone other than the member who recorded it';
  END IF;
  principals := ARRAY[NEW."recordedById"];
  IF NEW."delegationId" IS NOT NULL THEN
    SELECT * INTO dg FROM "ApprovalDelegation" d WHERE d."id" = NEW."delegationId" AND d."tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A committee decision recorded on a delegation names a delegation that exists';
    END IF;
    SELECT a."appliedAmount" INTO amount FROM "LoanApplication" a WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId";
    IF dg."delegateId" <> NEW."recordedById" OR dg."level" < NEW."level" OR dg."validFrom" > now() OR dg."validTo" < now()
      OR (dg."revokedAt" IS NOT NULL AND dg."revokedAt" <= now()) OR amount > dg."maxAmountCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A committee decision recorded on a delegation names a delegation to the recorder that is in force and reaches this level and amount';
    END IF;
    principals := principals || dg."delegatorId";
  END IF;
  seat := public."approvalSeatTaken"(NEW."caseId", NEW."tenantId", NEW."applicationId", principals, NEW."recordedById");
  IF seat = 'MAKER' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Maker-checker: the staff member who captured the application or changed its inputs cannot record its credit committee decision';
  ELSIF seat = 'SEATED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: someone who approved a level of the case, or whose authority was used for one, cannot record its credit committee decision';
  ELSIF seat IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: another member has already recorded a decision on this case on this member''s authority';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "CreditCommitteeDecision_guard" BEFORE INSERT ON "CreditCommitteeDecision" FOR EACH ROW EXECUTE FUNCTION public."guardCreditCommitteeDecision"();

-- A delegation: both parties are active staff of the lender (not the system account), and it only ever ends, by revocation.
CREATE OR REPLACE FUNCTION public."guardApprovalDelegation"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval delegation never goes away: revoke it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" IN (NEW."delegatorId", NEW."delegateId") AND u."active" AND NOT u."isSystem") <> 2 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Authority is delegated between two active staff members of the lender';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."revokedAt" IS NOT NULL
    OR NEW."revokedAt" IS NULL
    OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."delegatorId" IS DISTINCT FROM OLD."delegatorId" OR NEW."delegateId" IS DISTINCT FROM OLD."delegateId"
    OR NEW."level" IS DISTINCT FROM OLD."level" OR NEW."maxAmountCents" IS DISTINCT FROM OLD."maxAmountCents"
    OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom" OR NEW."validTo" IS DISTINCT FROM OLD."validTo"
    OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A delegation is never edited: it ends by revocation (once), or expires';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ApprovalDelegation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ApprovalDelegation" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalDelegation"();

-- Whether the lender's approval matrix is in force: its latest version that has taken effect (by the SAST calendar) is enabled.
CREATE OR REPLACE FUNCTION public."approvalMatrixInForce"(tenant_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT COALESCE((
    SELECT v."enabled" FROM "ApprovalMatrixVersion" v
    WHERE v."tenantId" = tenant_id AND v."effectiveFrom" <= (now() AT TIME ZONE 'Africa/Johannesburg')::date
    ORDER BY v."version" DESC LIMIT 1
  ), false);
$function$;

-- The application: it becomes APPROVED only once its open case's chain is complete (and, while the lender's matrix is in force, only
-- through such a case, whichever code wrote the status), a case ends when the application leaves review any other way, and nobody who
-- approved at any level disburses it.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationApprovalChain"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  c RECORD;
BEGIN
  IF NEW."status" = 'APPROVED'::"AppStatus" AND OLD."status" IS DISTINCT FROM 'APPROVED'::"AppStatus" THEN
    SELECT * INTO c FROM "ApprovalCase" WHERE "tenantId" = NEW."tenantId" AND "applicationId" = NEW."id" AND "status" = 'OPEN';
    IF FOUND THEN
      IF NOT "approvalChainSatisfied"(c."id") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approval matrix: every required level must approve before the application is approved';
      END IF;
      UPDATE "ApprovalCase" SET "status" = 'APPROVED', "completedAt" = now() WHERE "id" = c."id";
    ELSIF "approvalMatrixInForce"(NEW."tenantId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approval matrix: with the matrix in force an application is approved only through its approval chain';
    END IF;
  ELSIF OLD."status" = 'UNDER_REVIEW'::"AppStatus" AND NEW."status" NOT IN ('UNDER_REVIEW'::"AppStatus", 'APPROVED'::"AppStatus") THEN
    UPDATE "ApprovalCase" SET "status" = 'CLOSED', "completedAt" = now() WHERE "tenantId" = NEW."tenantId" AND "applicationId" = NEW."id" AND "status" = 'OPEN';
  END IF;
  IF NEW."status" = 'DISBURSED'::"AppStatus" AND OLD."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus"
    AND NEW."disbursedById" IS NOT NULL AND "tenantRequiresSegregationOfDuties"(NEW."tenantId")
    AND EXISTS (SELECT 1 FROM "ApprovalStep" s WHERE s."tenantId" = NEW."tenantId" AND s."applicationId" = NEW."id" AND s."approverId" = NEW."disbursedById")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: a staff member who approved at any level cannot disburse the application';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanApplication_y_guard_approval_chain" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (new.status IS DISTINCT FROM old.status) EXECUTE FUNCTION public."guardLoanApplicationApprovalChain"();

-- Tenant isolation (as 20261015130000_tenant_rls_new_scoped_models) ------------------------------------------

ALTER TABLE "ApprovalMatrixVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalMatrixVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalMatrixVersion" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApprovalCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalCase" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalStep" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApprovalEscalation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalEscalation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalEscalation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApprovalDelegation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalDelegation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalDelegation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CreditCommitteeDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditCommitteeDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CreditCommitteeDecision" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
