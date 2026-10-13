-- Credit checks v1: statement reads and REFER flags (lib/statement-analysis,
-- lib/credit-checks). Additive tables; the enforcement below ships with the
-- code that clears flags (app/api/applications/[id]/checks).

-- CreateEnum
CREATE TYPE "StatementReadMethod" AS ENUM ('TEXT', 'VLM');

-- CreateEnum
CREATE TYPE "StatementReadStatus" AS ENUM ('READ', 'UNREADABLE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "BalanceCheck" AS ENUM ('PASS', 'FAIL', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "CreditCheck" AS ENUM ('DOCUMENT_AUTHENTICITY', 'SALARY_MATCH', 'UNDISCLOSED_DEBT', 'RISK_BEHAVIOUR', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "CheckFlagStatus" AS ENUM ('OPEN', 'CLEARED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "StatementAnalysis" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientDocumentId" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "method" "StatementReadMethod" NOT NULL,
    "status" "StatementReadStatus" NOT NULL,
    "bank" TEXT,
    "accountHolderName" TEXT,
    "accountNumberLast4" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "openingBalanceCents" BIGINT,
    "closingBalanceCents" BIGINT,
    "transactions" JSONB NOT NULL,
    "balanceCheck" "BalanceCheck" NOT NULL,
    "balanceDiffCents" BIGINT,
    "authenticity" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationCheckFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "check" "CreditCheck" NOT NULL,
    "code" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "CheckFlagStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clearedById" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearReason" TEXT,

    CONSTRAINT "ApplicationCheckFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatementAnalysis_tenantId_idx" ON "StatementAnalysis"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementAnalysis_clientDocumentId_contentSha256_parserVers_key" ON "StatementAnalysis"("clientDocumentId", "contentSha256", "parserVersion");

-- CreateIndex
CREATE INDEX "ApplicationCheckFlag_tenantId_applicationId_status_idx" ON "ApplicationCheckFlag"("tenantId", "applicationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationCheckFlag_applicationId_fingerprint_key" ON "ApplicationCheckFlag"("applicationId", "fingerprint");

-- AddForeignKey
ALTER TABLE "StatementAnalysis" ADD CONSTRAINT "StatementAnalysis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementAnalysis" ADD CONSTRAINT "StatementAnalysis_clientDocumentId_fkey" FOREIGN KEY ("clientDocumentId") REFERENCES "ClientDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationCheckFlag" ADD CONSTRAINT "ApplicationCheckFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationCheckFlag" ADD CONSTRAINT "ApplicationCheckFlag_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApplicationCheckFlag" ADD CONSTRAINT "ApplicationCheckFlag_tenantId_clearedById_fkey" FOREIGN KEY ("tenantId", "clearedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────

-- A cleared flag names who cleared it, when, and why. The reason must say
-- something: 15 characters after trimming, the same floor the clear route
-- applies (lib/credit-checks/policy.ts CLEAR_REASON_MIN_LENGTH). An OPEN flag
-- carries no clearance at all, so a reopened flag cannot keep a stale one.
ALTER TABLE "ApplicationCheckFlag" ADD CONSTRAINT "ApplicationCheckFlag_clearance_complete" CHECK (
  ("status" <> 'CLEARED' OR ("clearedById" IS NOT NULL AND "clearedAt" IS NOT NULL AND char_length(btrim(coalesce("clearReason", ''))) >= 15))
  AND ("status" <> 'OPEN' OR ("clearedById" IS NULL AND "clearedAt" IS NULL AND "clearReason" IS NULL))
);

-- An application cannot become APPROVED while one of its credit-check flags is
-- OPEN. The decide route refuses first, with the list of flags; this is the
-- backstop for any other writer.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationOpenCheckFlags"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' AND EXISTS (
    SELECT 1 FROM "ApplicationCheckFlag" f
    WHERE f."applicationId" = NEW.id
      AND f."tenantId" = NEW."tenantId"
      AND f.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Application % has open credit-check flags; clear them before approval', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_no_open_check_flags_on_approval';
  END IF;
  RETURN NEW;
END;
$function$;

-- Named to sort first: Postgres fires same-event triggers in name order, and
-- an application with open flags should be refused for that reason rather
-- than for whichever other approval guard happens to run before it.
CREATE TRIGGER "LoanApplication_a0_guard_open_check_flags" BEFORE UPDATE OF status ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationOpenCheckFlags"();
