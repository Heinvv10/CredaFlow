-- CreateEnum
CREATE TYPE "AccountingBatchStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "XeroConnectionStatus" AS ENUM ('PENDING_AUTH', 'SELECT_ORGANISATION', 'CONNECTED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "AccountingPushStatus" AS ENUM ('SENDING', 'PUSHED', 'FAILED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DisbursementPayoutStatus" AS ENUM ('PENDING', 'SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'RETURNED', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "payoutProvider" TEXT,
ADD COLUMN     "payoutsEngineEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AccountingAccountMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT,
    "taxCode" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingAccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "AccountingBatchStatus" NOT NULL DEFAULT 'OPEN',
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "totalDebitCents" BIGINT NOT NULL DEFAULT 0,
    "totalCreditCents" BIGINT NOT NULL DEFAULT 0,
    "linesSha256" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AccountingExportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "baseKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "postingDate" TEXT NOT NULL,
    "loanId" TEXT,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "AccountingLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingJournalLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "taxCode" TEXT,
    "debitCents" INTEGER NOT NULL DEFAULT 0,
    "creditCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountingJournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "XeroConnectionStatus" NOT NULL,
    "authState" TEXT,
    "authVerifierSealed" TEXT,
    "authStartedAt" TIMESTAMP(3),
    "authStartedById" TEXT,
    "accessTokenSealed" TEXT,
    "refreshTokenSealed" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "organisations" JSONB,
    "xeroTenantId" TEXT,
    "xeroTenantName" TEXT,
    "xeroConnectionId" TEXT,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingXeroPush" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "status" "AccountingPushStatus" NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "xeroManualJournalId" TEXT,
    "error" TEXT,
    "pushedById" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingXeroPush_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisbursementPayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "status" "DisbursementPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "providerReference" TEXT,
    "failureReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisbursementPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingAccountMapping_tenantId_role_key" ON "AccountingAccountMapping"("tenantId", "role");

-- CreateIndex
CREATE INDEX "AccountingExportBatch_tenantId_periodStart_idx" ON "AccountingExportBatch"("tenantId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExportBatch_tenantId_periodKey_key" ON "AccountingExportBatch"("tenantId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExportBatch_tenantId_id_key" ON "AccountingExportBatch"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AccountingLedgerEntry_tenantId_baseKey_idx" ON "AccountingLedgerEntry"("tenantId", "baseKey");

-- CreateIndex
CREATE INDEX "AccountingLedgerEntry_batchId_idx" ON "AccountingLedgerEntry"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingLedgerEntry_tenantId_eventKey_key" ON "AccountingLedgerEntry"("tenantId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingLedgerEntry_tenantId_id_key" ON "AccountingLedgerEntry"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AccountingJournalLine_entryId_idx" ON "AccountingJournalLine"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingJournalLine_batchId_lineNo_key" ON "AccountingJournalLine"("batchId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "XeroConnection_tenantId_key" ON "XeroConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "XeroConnection_authState_key" ON "XeroConnection"("authState");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingXeroPush_batchId_key" ON "AccountingXeroPush"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingXeroPush_tenantId_batchId_key" ON "AccountingXeroPush"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPayout_applicationId_key" ON "DisbursementPayout"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPayout_loanId_key" ON "DisbursementPayout"("loanId");

-- CreateIndex
CREATE INDEX "DisbursementPayout_tenantId_status_idx" ON "DisbursementPayout"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPayout_tenantId_idempotencyKey_key" ON "DisbursementPayout"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPayout_tenantId_loanId_key" ON "DisbursementPayout"("tenantId", "loanId");

-- AddForeignKey
ALTER TABLE "AccountingAccountMapping" ADD CONSTRAINT "AccountingAccountMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingExportBatch" ADD CONSTRAINT "AccountingExportBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingLedgerEntry" ADD CONSTRAINT "AccountingLedgerEntry_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "AccountingExportBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingJournalLine" ADD CONSTRAINT "AccountingJournalLine_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "AccountingExportBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingJournalLine" ADD CONSTRAINT "AccountingJournalLine_tenantId_entryId_fkey" FOREIGN KEY ("tenantId", "entryId") REFERENCES "AccountingLedgerEntry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingXeroPush" ADD CONSTRAINT "AccountingXeroPush_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "AccountingExportBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written guards (Prisma does not diff these). Read by
-- lib/accounting/accounting.integration.test.ts and
-- lib/payouts/payouts.integration.test.ts, which exercise every rule below.
-- ════════════════════════════════════════════════════════════════════════════

-- A journal line is a debit or a credit of a positive amount, never both.
ALTER TABLE "AccountingJournalLine" ADD CONSTRAINT "AccountingJournalLine_one_side"
  CHECK ("debitCents" >= 0 AND "creditCents" >= 0 AND (("debitCents" = 0) <> ("creditCents" = 0)));

-- A batch's own totals balance, and a closed batch carries its seal.
ALTER TABLE "AccountingExportBatch" ADD CONSTRAINT "AccountingExportBatch_balanced"
  CHECK ("totalDebitCents" = "totalCreditCents" AND "totalDebitCents" >= 0);
ALTER TABLE "AccountingExportBatch" ADD CONSTRAINT "AccountingExportBatch_period"
  CHECK ("periodKey" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "periodEnd" > "periodStart");
ALTER TABLE "AccountingExportBatch" ADD CONSTRAINT "AccountingExportBatch_closed_sealed"
  CHECK ("status" = 'OPEN' OR ("closedAt" IS NOT NULL AND "linesSha256" IS NOT NULL));

-- A batch is created OPEN, filled, and closed in the same transaction. Closing
-- proves the stored totals are the lines' totals and that every entry
-- balances on its own. A CLOSED batch never changes and no batch is deleted.
CREATE OR REPLACE FUNCTION public."guardAccountingBatch"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  sum_debit BIGINT;
  sum_credit BIGINT;
  n_lines INTEGER;
  n_entries INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: an export batch is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting batch guard: a batch is created OPEN and closed after its lines exist';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: a closed accounting period is immutable';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."periodKey" IS DISTINCT FROM OLD."periodKey"
    OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: a batch''s period never changes';
  END IF;
  IF NEW."status" = 'CLOSED' THEN
    SELECT COALESCE(SUM(l."debitCents"), 0), COALESCE(SUM(l."creditCents"), 0), COUNT(*)
      INTO sum_debit, sum_credit, n_lines
      FROM "AccountingJournalLine" l WHERE l."batchId" = NEW."id";
    SELECT COUNT(*) INTO n_entries FROM "AccountingLedgerEntry" e WHERE e."batchId" = NEW."id";
    IF sum_debit <> sum_credit THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('Accounting batch guard: journals do not balance (debits %s, credits %s)', sum_debit, sum_credit);
    END IF;
    IF sum_debit <> NEW."totalDebitCents" OR sum_credit <> NEW."totalCreditCents"
      OR n_lines <> NEW."lineCount" OR n_entries <> NEW."entryCount"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting batch guard: stored totals differ from the batch''s lines';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "AccountingJournalLine" l WHERE l."batchId" = NEW."id"
      GROUP BY l."entryId" HAVING SUM(l."debitCents") <> SUM(l."creditCents")
    ) OR EXISTS (
      SELECT 1 FROM "AccountingLedgerEntry" e WHERE e."batchId" = NEW."id"
        AND NOT EXISTS (SELECT 1 FROM "AccountingJournalLine" l WHERE l."entryId" = e."id")
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting batch guard: every ledger entry must balance on its own';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardAccountingBatch"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingExportBatch"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingBatch"();

-- No transaction may commit an OPEN batch: generation closes what it opens.
CREATE OR REPLACE FUNCTION public."requireAccountingBatchClosedAtCommit"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountingExportBatch" b WHERE b."id" = NEW."id" AND b."status" <> 'CLOSED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: a batch must be closed in the transaction that creates it';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "requireAccountingBatchClosedAtCommit"
  AFTER INSERT ON "AccountingExportBatch"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public."requireAccountingBatchClosedAtCommit"();

-- Ledger entries and journal lines are append-only, and only into an OPEN batch.
CREATE OR REPLACE FUNCTION public."guardAccountingLedgerRow"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  batch_status TEXT;
  entry_batch TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: exported ledger rows are never changed or deleted';
  END IF;
  SELECT b."status"::TEXT INTO batch_status FROM "AccountingExportBatch" b
    WHERE b."id" = NEW."batchId" AND b."tenantId" = NEW."tenantId";
  IF batch_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting batch guard: a closed accounting period is immutable';
  END IF;
  IF TG_TABLE_NAME = 'AccountingJournalLine' THEN
    SELECT e."batchId" INTO entry_batch FROM "AccountingLedgerEntry" e WHERE e."id" = NEW."entryId";
    IF entry_batch IS DISTINCT FROM NEW."batchId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting batch guard: a line belongs to an entry of the same batch';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardAccountingLedgerEntry"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingLedgerRow"();
CREATE TRIGGER "guardAccountingJournalLine"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingJournalLine"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingLedgerRow"();

-- A Xero push is claimed (SENDING) for a CLOSED batch before the request
-- leaves. A definite failure may be claimed again; an unknown outcome
-- (NEEDS_REVIEW) is resolved by a person; PUSHED is final.
CREATE OR REPLACE FUNCTION public."guardAccountingXeroPush"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting push guard: a push starts as a SENDING claim';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AccountingExportBatch" b
      WHERE b."id" = NEW."batchId" AND b."tenantId" = NEW."tenantId" AND b."status" = 'CLOSED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting push guard: only a closed batch is pushed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."batchId" IS DISTINCT FROM OLD."batchId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push stays with its batch';
  END IF;
  IF NOT (
    (OLD."status" = 'SENDING' AND NEW."status" IN ('PUSHED', 'FAILED', 'NEEDS_REVIEW'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'SENDING')
    OR (OLD."status" = 'NEEDS_REVIEW' AND NEW."status" IN ('PUSHED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Accounting push guard: %s -> %s is not allowed', OLD."status", NEW."status");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardAccountingXeroPush"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingXeroPush"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingXeroPush"();

-- ── Payouts ─────────────────────────────────────────────────────────────────

ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_amount_positive"
  CHECK ("amountCents" > 0);
ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_idempotency_key_bound"
  CHECK ("idempotencyKey" = 'disburse:' || "applicationId");

-- A payout is created PENDING for the loan booked from its own application.
-- Its terms (who, where, how much, under which key) never change, no row is
-- deleted, and its status moves only along the payout state machine
-- (lib/payouts/state.ts mirrors it).
CREATE OR REPLACE FUNCTION public."guardDisbursementPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  loan_application TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."submittedAt" IS NOT NULL OR NEW."providerReference" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout is created PENDING and unsent';
    END IF;
    SELECT l."applicationId" INTO loan_application FROM "Loan" l
      WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_application IS DISTINCT FROM NEW."applicationId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout pays the loan booked from its own application';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."accountHolder" IS DISTINCT FROM OLD."accountHolder"
    OR NEW."bankName" IS DISTINCT FROM OLD."bankName"
    OR NEW."branchCode" IS DISTINCT FROM OLD."branchCode"
    OR NEW."accountNumber" IS DISTINCT FROM OLD."accountNumber"
    OR NEW."accountType" IS DISTINCT FROM OLD."accountType"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout''s terms never change';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF OLD."status" IN ('PAID', 'FAILED', 'RETURNED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a settled payout is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" = 'SUBMITTING')
    OR (OLD."status" = 'SUBMITTING' AND NEW."status" IN ('SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'NEEDS_REVIEW'))
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('PROCESSING', 'PAID', 'FAILED', 'RETURNED', 'NEEDS_REVIEW'))
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('PAID', 'FAILED', 'RETURNED', 'NEEDS_REVIEW'))
    OR (OLD."status" = 'PAID' AND NEW."status" = 'RETURNED')
    OR (OLD."status" = 'NEEDS_REVIEW' AND NEW."status" IN ('PAID', 'FAILED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Payout guard: %s -> %s is not allowed', OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'SUBMITTING' AND NEW."submittedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a claim to send records when it was taken';
  END IF;
  IF OLD."status" = 'NEEDS_REVIEW' AND (NEW."resolvedById" IS NULL OR NEW."resolutionNote" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout under review is resolved by a named person with a note';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardDisbursementPayout"
  BEFORE INSERT OR UPDATE OR DELETE ON "DisbursementPayout"
  FOR EACH ROW EXECUTE FUNCTION public."guardDisbursementPayout"();
