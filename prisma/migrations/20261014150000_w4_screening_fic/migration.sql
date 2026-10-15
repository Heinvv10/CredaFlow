-- CreateEnum
CREATE TYPE "ScreeningType" AS ENUM ('PEP', 'SANCTIONS', 'ADVERSE_MEDIA');

-- CreateEnum
CREATE TYPE "ScreeningResult" AS ENUM ('CLEAR', 'POSSIBLE_MATCH', 'CONFIRMED_MATCH', 'ERROR');

-- CreateEnum
CREATE TYPE "ScreeningDecision" AS ENUM ('FALSE_POSITIVE', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScreeningTrigger" AS ENUM ('APPLICATION_SUBMIT', 'PRE_APPROVAL', 'PERIODIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "CashThresholdReportStatus" AS ENUM ('FILED', 'NOT_REPORTABLE');

-- CreateEnum
CREATE TYPE "SuspiciousReportKind" AS ENUM ('SUSPICIOUS_TRANSACTION', 'UNUSUAL_TRANSACTION', 'SUSPICIOUS_ACTIVITY');

-- CreateEnum
CREATE TYPE "SuspiciousReportStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'REPORTED', 'CLOSED_NO_REPORT');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "screeningProvider" TEXT,
ADD COLUMN     "screeningReviewMinRole" "UserRole" NOT NULL DEFAULT 'ADMIN';

-- CreateTable
CREATE TABLE "ScreeningCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "trigger" "ScreeningTrigger" NOT NULL,
    "applicationId" TEXT,
    "provider" TEXT NOT NULL,
    "type" "ScreeningType" NOT NULL,
    "result" "ScreeningResult" NOT NULL,
    "matches" JSONB NOT NULL DEFAULT '[]',
    "matchFingerprint" TEXT,
    "providerReference" TEXT,
    "errorCode" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "decision" "ScreeningDecision",
    "decisionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "carriedFromCheckId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashThresholdReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "CashThresholdReportStatus" NOT NULL,
    "fiuReference" TEXT,
    "filedAt" TIMESTAMP(3),
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashThresholdReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuspiciousReportCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "SuspiciousReportKind" NOT NULL,
    "clientId" TEXT,
    "loanId" TEXT,
    "paymentId" TEXT,
    "grounds" TEXT NOT NULL,
    "status" "SuspiciousReportStatus" NOT NULL DEFAULT 'OPEN',
    "raisedById" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessedById" TEXT,
    "assessedAt" TIMESTAMP(3),
    "assessmentNote" TEXT,
    "fiuReference" TEXT,
    "reportedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuspiciousReportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuspiciousReportAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousReportAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RmcpDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "reviewDueAt" DATE NOT NULL,

    CONSTRAINT "RmcpDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScreeningCheck_tenantId_clientId_createdAt_idx" ON "ScreeningCheck"("tenantId", "clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ScreeningCheck_tenantId_runId_idx" ON "ScreeningCheck"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningCheck_tenantId_id_key" ON "ScreeningCheck"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CashThresholdReport_tenantId_status_idx" ON "CashThresholdReport"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CashThresholdReport_tenantId_paymentId_key" ON "CashThresholdReport"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "SuspiciousReportCase_tenantId_status_idx" ON "SuspiciousReportCase"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SuspiciousReportCase_tenantId_id_key" ON "SuspiciousReportCase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SuspiciousReportCase_tenantId_reference_key" ON "SuspiciousReportCase"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "SuspiciousReportAccess_tenantId_caseId_idx" ON "SuspiciousReportAccess"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "SuspiciousReportAccess_tenantId_createdAt_idx" ON "SuspiciousReportAccess"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RmcpDocument_tenantId_version_key" ON "RmcpDocument"("tenantId", "version");

-- AddForeignKey
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CashThresholdReport" ADD CONSTRAINT "CashThresholdReport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashThresholdReport" ADD CONSTRAINT "CashThresholdReport_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SuspiciousReportAccess" ADD CONSTRAINT "SuspiciousReportAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousReportAccess" ADD CONSTRAINT "SuspiciousReportAccess_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "SuspiciousReportCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RmcpDocument" ADD CONSTRAINT "RmcpDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- Static readers: lib/screening/screening-migration.test.ts.
-- Behaviour: lib/screening/db-enforcement.integration.test.ts (RUN_SCREENING_IT).

-- A decision names when it was made and why (15+ characters, the floor of
-- lib/screening/policy.ts REVIEW_REASON_MIN_LENGTH), and EITHER the reviewer
-- OR the earlier check it was carried forward from — never both, never neither.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_decision_complete" CHECK (
  ("decision" IS NULL AND "decisionReason" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "carriedFromCheckId" IS NULL)
  OR ("decision" IS NOT NULL AND "reviewedAt" IS NOT NULL
      AND char_length(btrim(coalesce("decisionReason", ''))) >= 15
      AND (("reviewedById" IS NOT NULL) <> ("carriedFromCheckId" IS NOT NULL)))
);

-- Only a match is decided. A clear result needs nothing; an error is re-run.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_decision_only_on_match" CHECK (
  "decision" IS NULL OR "result" IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH')
);

-- A confirmed sanctions match is a hard stop: it carries no decision at all,
-- so nothing can clear it. A possible sanctions match may be found to be a
-- false positive or confirmed (REJECTED), never ACCEPTED.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_sanctions_never_cleared" CHECK (
  NOT ("type" = 'SANCTIONS' AND "result" = 'CONFIRMED_MATCH' AND "decision" IS NOT NULL)
  AND NOT ("type" = 'SANCTIONS' AND "decision" = 'ACCEPTED')
);

-- A match carries the fingerprint carry-forward keys on; nothing else does.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_match_fingerprint" CHECK (
  ("result" IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH')) = ("matchFingerprint" IS NOT NULL)
);

-- A screening check is a record. Never deleted or truncated. Born undecided,
-- unless it carries forward the decision of an earlier check of the same
-- client, type and match fingerprint. Afterwards only the one-time review
-- decision may be written, and once written it never changes.
CREATE OR REPLACE FUNCTION public."guardScreeningCheckRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Screening checks cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.decision IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "ScreeningCheck" p
      WHERE p.id = NEW."carriedFromCheckId"
        AND p."tenantId" = NEW."tenantId"
        AND p."clientId" = NEW."clientId"
        AND p.type = NEW.type
        AND p."matchFingerprint" = NEW."matchFingerprint"
        AND p.decision = NEW.decision
    ) THEN
      RAISE EXCEPTION 'A screening check is born undecided unless it carries an earlier identical decision'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_born_undecided';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Screening check % is decided and cannot change', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_decided_immutable';
  END IF;
  IF (NEW.id, NEW."tenantId", NEW."clientId", NEW."runId", NEW.trigger, NEW."applicationId", NEW.provider,
      NEW.type, NEW.result, NEW.matches, NEW."matchFingerprint", NEW."providerReference", NEW."errorCode",
      NEW.simulated, NEW."carriedFromCheckId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."tenantId", OLD."clientId", OLD."runId", OLD.trigger, OLD."applicationId", OLD.provider,
      OLD.type, OLD.result, OLD.matches, OLD."matchFingerprint", OLD."providerReference", OLD."errorCode",
      OLD.simulated, OLD."carriedFromCheckId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Screening check % may only receive its review decision', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_transition';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ScreeningCheck_guard_record" BEFORE INSERT OR UPDATE OR DELETE ON "ScreeningCheck" FOR EACH ROW EXECUTE FUNCTION "guardScreeningCheckRecord"();
CREATE TRIGGER "ScreeningCheck_guard_truncate" BEFORE TRUNCATE ON "ScreeningCheck" FOR EACH STATEMENT EXECUTE FUNCTION "guardScreeningCheckRecord"();

-- An application of a tenant with screening configured cannot reach APPROVED,
-- or DISBURSED, while its client's latest screening run blocks: no run at all,
-- a provider error, an undecided match, a REJECTED match, or a confirmed
-- sanctions match (which can carry no decision). Tenants without a provider are
-- untouched. The decide and disburse routes refuse first, with reasons; this is
-- the backstop for any other writer. The app also refuses simulated evidence on
-- a deployment that forbids it, which SQL cannot see.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationScreening"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  configured TEXT;
  latest_run TEXT;
BEGIN
  IF NEW.status NOT IN ('APPROVED', 'DISBURSED') OR NEW."clientId" IS NULL
     OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NEW;
  END IF;
  SELECT c."screeningProvider" INTO configured FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
  IF configured IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s."runId" INTO latest_run FROM "ScreeningCheck" s
   WHERE s."tenantId" = NEW."tenantId" AND s."clientId" = NEW."clientId"
   ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1;
  IF latest_run IS NULL THEN
    RAISE EXCEPTION 'Application % cannot be approved: its client has not been screened', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_screening_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ScreeningCheck" s
     WHERE s."tenantId" = NEW."tenantId" AND s."runId" = latest_run
       AND (s.result = 'ERROR'
            OR (s.result IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH') AND (s.decision IS NULL OR s.decision = 'REJECTED')))
  ) THEN
    RAISE EXCEPTION 'Application % cannot be approved: its client''s screening blocks approval', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_screening_blocks_approval';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_a1_guard_screening" BEFORE INSERT OR UPDATE OF status ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationScreening"();

-- One generic guard for the FIC registers: no DELETE or TRUNCATE ever, and no
-- UPDATE either when TG_ARGV[1] is 'append-only'.
CREATE OR REPLACE FUNCTION public."guardFicRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0];
  END IF;
  IF TG_OP = 'UPDATE' AND TG_ARGV[1] = 'append-only' THEN
    RAISE EXCEPTION '% records cannot be changed', TG_TABLE_NAME
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0];
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$function$;

-- Cash threshold register: what was done with a reportable cash receipt.
-- FILED names the FIC reference and when; NOT_REPORTABLE says why. Positive
-- amount. Append-only: the record of a filing is not edited afterwards.
ALTER TABLE "CashThresholdReport" ADD CONSTRAINT "CashThresholdReport_outcome_complete" CHECK (
  "amountCents" > 0
  AND (
    ("status" = 'FILED' AND char_length(btrim(coalesce("fiuReference", ''))) > 0 AND "filedAt" IS NOT NULL)
    OR ("status" = 'NOT_REPORTABLE' AND char_length(btrim(coalesce("note", ''))) >= 15
        AND "fiuReference" IS NULL AND "filedAt" IS NULL)
  )
);
CREATE TRIGGER "CashThresholdReport_guard_record" BEFORE UPDATE OR DELETE ON "CashThresholdReport" FOR EACH ROW EXECUTE FUNCTION "guardFicRecord"('CashThresholdReport_append_only', 'append-only');
CREATE TRIGGER "CashThresholdReport_guard_truncate" BEFORE TRUNCATE ON "CashThresholdReport" FOR EACH STATEMENT EXECUTE FUNCTION "guardFicRecord"('CashThresholdReport_append_only', 'append-only');

-- STR access log: append-only.
CREATE TRIGGER "SuspiciousReportAccess_guard_record" BEFORE UPDATE OR DELETE ON "SuspiciousReportAccess" FOR EACH ROW EXECUTE FUNCTION "guardFicRecord"('SuspiciousReportAccess_append_only', 'append-only');
CREATE TRIGGER "SuspiciousReportAccess_guard_truncate" BEFORE TRUNCATE ON "SuspiciousReportAccess" FOR EACH STATEMENT EXECUTE FUNCTION "guardFicRecord"('SuspiciousReportAccess_append_only', 'append-only');

-- STR case: grounds say something (20+ characters, lib/fic/str-cases.ts
-- GROUNDS_MIN_LENGTH). An OPEN or UNDER_REVIEW case carries no outcome;
-- REPORTED names the assessor and the FIC reference; CLOSED_NO_REPORT the
-- assessor and why (15+ characters).
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_outcome_complete" CHECK (
  char_length(btrim("grounds")) >= 20
  AND (
    ("status" IN ('OPEN', 'UNDER_REVIEW') AND "fiuReference" IS NULL AND "reportedAt" IS NULL AND "closedAt" IS NULL)
    OR ("status" = 'REPORTED' AND char_length(btrim(coalesce("fiuReference", ''))) > 0 AND "reportedAt" IS NOT NULL
        AND "assessedById" IS NOT NULL AND "assessedAt" IS NOT NULL AND "closedAt" IS NULL)
    OR ("status" = 'CLOSED_NO_REPORT' AND char_length(btrim(coalesce("assessmentNote", ''))) >= 15
        AND "assessedById" IS NOT NULL AND "assessedAt" IS NOT NULL AND "closedAt" IS NOT NULL
        AND "fiuReference" IS NULL AND "reportedAt" IS NULL)
  )
);

-- STR case lifecycle: raised OPEN; OPEN -> UNDER_REVIEW -> REPORTED |
-- CLOSED_NO_REPORT (OPEN may go straight to either); a decided case never
-- changes; what was raised (who, when, about whom, on what grounds) never
-- changes; never deleted.
CREATE OR REPLACE FUNCTION public."guardSuspiciousReportCase"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'STR cases cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'SuspiciousReportCase_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'An STR case is raised OPEN, not %', NEW.status
        USING ERRCODE = '23514', CONSTRAINT = 'SuspiciousReportCase_born_open';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('REPORTED', 'CLOSED_NO_REPORT') THEN
    RAISE EXCEPTION 'STR case % is decided and cannot change', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'SuspiciousReportCase_decided_immutable';
  END IF;
  IF (NEW."tenantId", NEW.reference, NEW.kind, NEW."clientId", NEW."loanId", NEW."paymentId", NEW.grounds,
      NEW."raisedById", NEW."raisedAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD.reference, OLD.kind, OLD."clientId", OLD."loanId", OLD."paymentId", OLD.grounds,
      OLD."raisedById", OLD."raisedAt")
     OR (OLD.status = 'UNDER_REVIEW' AND NEW.status = 'OPEN') THEN
    RAISE EXCEPTION 'STR case % cannot change what was raised or step backwards', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'SuspiciousReportCase_transition';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "SuspiciousReportCase_guard_record" BEFORE INSERT OR UPDATE OR DELETE ON "SuspiciousReportCase" FOR EACH ROW EXECUTE FUNCTION "guardSuspiciousReportCase"();
CREATE TRIGGER "SuspiciousReportCase_guard_truncate" BEFORE TRUNCATE ON "SuspiciousReportCase" FOR EACH STATEMENT EXECUTE FUNCTION "guardSuspiciousReportCase"();

-- RMCP: a version is never deleted and its file never changes; approval is
-- written once, whole (who and when together).
ALTER TABLE "RmcpDocument" ADD CONSTRAINT "RmcpDocument_approval_complete" CHECK (
  ("approvedById" IS NULL) = ("approvedAt" IS NULL) AND "version" > 0
);

CREATE OR REPLACE FUNCTION public."guardRmcpDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'RMCP versions cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'RmcpDocument_no_delete';
  END IF;
  IF OLD."approvedById" IS NOT NULL
     OR (NEW.id, NEW."tenantId", NEW.version, NEW.title, NEW."fileName", NEW."mimeType", NEW."storagePath",
         NEW.sha256, NEW."fileSize", NEW."uploadedById", NEW."uploadedAt", NEW."reviewDueAt")
        IS DISTINCT FROM
        (OLD.id, OLD."tenantId", OLD.version, OLD.title, OLD."fileName", OLD."mimeType", OLD."storagePath",
         OLD.sha256, OLD."fileSize", OLD."uploadedById", OLD."uploadedAt", OLD."reviewDueAt") THEN
    RAISE EXCEPTION 'RMCP version % may only be approved, once', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'RmcpDocument_transition';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "RmcpDocument_guard_record" BEFORE UPDATE OR DELETE ON "RmcpDocument" FOR EACH ROW EXECUTE FUNCTION "guardRmcpDocument"();
CREATE TRIGGER "RmcpDocument_guard_truncate" BEFORE TRUNCATE ON "RmcpDocument" FOR EACH STATEMENT EXECUTE FUNCTION "guardRmcpDocument"();
