-- W6 review round 1 (PR #89): payout retries and disbursement reversal
-- (maker-checker), accounting settings (mapping confirmation, go-live month,
-- VAT), opening positions, VAT-split journal lines.

-- CreateEnum
CREATE TYPE "DisbursementReversalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- DropIndex
DROP INDEX "DisbursementPayout_applicationId_key";

-- DropIndex
DROP INDEX "DisbursementPayout_loanId_key";

-- DropIndex
DROP INDEX "DisbursementPayout_tenantId_loanId_key";

-- AlterTable
ALTER TABLE "AccountingAccountMapping" ADD COLUMN     "vatInclusive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AccountingJournalLine" ADD COLUMN     "sourceRole" TEXT;

-- AlterTable. disbursedById is backfilled from createdById (attempt 1 is the
-- only attempt that can exist yet) with the payout guard briefly disabled:
-- the guard refuses any same-status update of a settled payout.
ALTER TABLE "DisbursementPayout" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "disbursedById" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "retryOfId" TEXT,
ADD COLUMN     "returnedAt" TIMESTAMP(3);
ALTER TABLE "DisbursementPayout" DISABLE TRIGGER "guardDisbursementPayout";
UPDATE "DisbursementPayout" SET "disbursedById" = "createdById";
UPDATE "DisbursementPayout" SET "paidAt" = COALESCE("resolvedAt", "updatedAt") WHERE "status" = 'PAID';
UPDATE "DisbursementPayout" SET "returnedAt" = COALESCE("resolvedAt", "updatedAt") WHERE "status" = 'RETURNED';
ALTER TABLE "DisbursementPayout" ENABLE TRIGGER "guardDisbursementPayout";
ALTER TABLE "DisbursementPayout" ALTER COLUMN "disbursedById" SET NOT NULL;

-- CreateTable
CREATE TABLE "DisbursementReversal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "status" "DisbursementReversalStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "DisbursementReversal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingSettings" (
    "tenantId" TEXT NOT NULL,
    "mappingConfirmedAt" TIMESTAMP(3),
    "mappingConfirmedById" TEXT,
    "goLiveMonth" TEXT,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBps" INTEGER NOT NULL DEFAULT 1500,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "AccountingOpeningPosition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "baseKey" TEXT NOT NULL,
    "loanId" TEXT,
    "reference" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,

    CONSTRAINT "AccountingOpeningPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisbursementReversal_tenantId_loanId_idx" ON "DisbursementReversal"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "AccountingOpeningPosition_tenantId_baseKey_idx" ON "AccountingOpeningPosition"("tenantId", "baseKey");

-- CreateIndex
CREATE INDEX "AccountingOpeningPosition_batchId_idx" ON "AccountingOpeningPosition"("batchId");

-- CreateIndex
CREATE INDEX "DisbursementPayout_loanId_idx" ON "DisbursementPayout"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPayout_applicationId_attempt_key" ON "DisbursementPayout"("applicationId", "attempt");

-- AddForeignKey
ALTER TABLE "DisbursementReversal" ADD CONSTRAINT "DisbursementReversal_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingSettings" ADD CONSTRAINT "AccountingSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingOpeningPosition" ADD CONSTRAINT "AccountingOpeningPosition_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "AccountingExportBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written guards. Exercised by lib/payouts/payouts.integration.test.ts,
-- lib/payouts/retry-reversal.integration.test.ts and
-- lib/accounting/accounting.integration.test.ts.
-- ════════════════════════════════════════════════════════════════════════════

-- Attempt 1 keeps disburse:<applicationId>; a retry is disburse:<applicationId>:<attempt>.
ALTER TABLE "DisbursementPayout" DROP CONSTRAINT "DisbursementPayout_idempotency_key_bound";
ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_idempotency_key_bound"
  CHECK ("attempt" >= 1 AND "idempotencyKey" = 'disburse:' || "applicationId" || CASE WHEN "attempt" = 1 THEN '' ELSE ':' || "attempt" END);

-- At most one attempt per application that is not over: never two payouts in flight.
CREATE UNIQUE INDEX "DisbursementPayout_one_open_attempt" ON "DisbursementPayout"("applicationId")
  WHERE "status" NOT IN ('FAILED', 'RETURNED', 'CANCELLED');

-- One live (not rejected) reversal request per loan.
CREATE UNIQUE INDEX "DisbursementReversal_one_open_per_loan" ON "DisbursementReversal"("loanId")
  WHERE "status" <> 'REJECTED';

ALTER TABLE "AccountingSettings" ADD CONSTRAINT "AccountingSettings_values"
  CHECK (("goLiveMonth" IS NULL OR "goLiveMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND "vatRateBps" BETWEEN 0 AND 10000);

CREATE OR REPLACE FUNCTION public."guardDisbursementPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  loan_application TEXT;
  previous RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."submittedAt" IS NOT NULL OR NEW."providerReference" IS NOT NULL OR NEW."paidAt" IS NOT NULL OR NEW."returnedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout is created unsent';
    END IF;
    SELECT l."applicationId" INTO loan_application FROM "Loan" l
      WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_application IS DISTINCT FROM NEW."applicationId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout pays the loan booked from its own application';
    END IF;
    IF NEW."attempt" = 1 THEN
      IF NEW."status" <> 'PENDING' OR NEW."retryOfId" IS NOT NULL OR NEW."disbursedById" IS DISTINCT FROM NEW."createdById" THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Payout guard: a payout is created PENDING and unsent, by the disburser';
      END IF;
      RETURN NEW;
    END IF;
    -- A retry: waits for approval, follows the previous attempt, which is over
    -- and is for the same money, disbursed by the same person.
    SELECT p.* INTO previous FROM "DisbursementPayout" p
      WHERE p."id" = NEW."retryOfId" AND p."tenantId" = NEW."tenantId";
    IF NEW."status" <> 'AWAITING_APPROVAL' OR NEW."approvedById" IS NOT NULL OR NEW."requestedById" IS DISTINCT FROM NEW."createdById"
      OR previous."id" IS NULL OR previous."applicationId" <> NEW."applicationId" OR previous."attempt" <> NEW."attempt" - 1
      OR previous."status" NOT IN ('FAILED', 'RETURNED', 'CANCELLED')
      OR previous."amountCents" <> NEW."amountCents" OR previous."disbursedById" <> NEW."disbursedById"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a retry awaits approval and follows a failed, returned or cancelled attempt of the same payout';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."retryOfId" IS DISTINCT FROM OLD."retryOfId"
    OR NEW."disbursedById" IS DISTINCT FROM OLD."disbursedById"
    OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
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
    OR (OLD."approvedById" IS NOT NULL AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout''s terms never change';
  END IF;
  -- Maker-checker: whoever settles a payout by hand is neither the disburser
  -- nor the person who created this attempt.
  IF OLD."resolvedById" IS NULL AND NEW."resolvedById" IS NOT NULL
    AND (NEW."resolvedById" = NEW."disbursedById" OR NEW."resolvedById" = NEW."createdById")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: the disburser or the requester cannot settle this payout';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF OLD."status" IN ('PAID', 'FAILED', 'RETURNED', 'CANCELLED') THEN
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
    OR (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('PENDING', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Payout guard: %s -> %s is not allowed', OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'SUBMITTING' AND NEW."submittedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a claim to send records when it was taken';
  END IF;
  IF (NEW."status" = 'PAID' AND NEW."paidAt" IS NULL) OR (NEW."status" = 'RETURNED' AND NEW."returnedAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a paid or returned payout records when';
  END IF;
  IF OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" = 'PENDING' AND (
    NEW."approvedById" IS NULL OR NEW."approvedAt" IS NULL
    OR NEW."approvedById" = NEW."requestedById" OR NEW."approvedById" = NEW."disbursedById"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a retry is approved by a second person, neither the requester nor the disburser';
  END IF;
  IF OLD."status" IN ('NEEDS_REVIEW', 'AWAITING_APPROVAL') AND NEW."status" IN ('PAID', 'FAILED', 'CANCELLED')
    AND (NEW."resolvedById" IS NULL OR NEW."resolutionNote" IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout under review is resolved by a named person with a note';
  END IF;
  RETURN NEW;
END;
$function$;

-- A reversal is requested while every attempt is over, and approved by a
-- second person (not the requester, not the disburser) only if that still
-- holds and no receipt on the loan is live. Decided requests never change.
CREATE OR REPLACE FUNCTION public."guardDisbursementReversal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  disburser TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a reversal request is never deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId")
    OR EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId"
      AND p."status" NOT IN ('FAILED', 'RETURNED', 'CANCELLED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a disbursement is reversed only when every payout attempt failed, was returned or was cancelled';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Reversal guard: a reversal is created as an undecided request';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'REQUESTED' OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
    OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a request is decided once and never changes';
  END IF;
  SELECT p."disbursedById" INTO disburser FROM "DisbursementPayout" p
    WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId" AND p."attempt" = 1;
  IF NEW."decidedById" IS NULL OR NEW."decidedAt" IS NULL
    OR NEW."decidedById" = NEW."requestedById" OR NEW."decidedById" = disburser
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a reversal is decided by a second person, neither the requester nor the disburser';
  END IF;
  IF NEW."status" = 'APPROVED' AND EXISTS (
    SELECT 1 FROM "Payment" pay WHERE pay."loanId" = NEW."loanId" AND pay."tenantId" = NEW."tenantId" AND pay."reversed" = FALSE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a loan with a live receipt is not reversed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardDisbursementReversal"
  BEFORE INSERT OR UPDATE OR DELETE ON "DisbursementReversal"
  FOR EACH ROW EXECUTE FUNCTION public."guardDisbursementReversal"();

-- Opening positions are append-only, into an OPEN batch, like ledger rows.
CREATE TRIGGER "guardAccountingOpeningPosition"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingOpeningPosition"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingLedgerRow"();

-- Closing also proves the opening positions net to zero.
CREATE OR REPLACE FUNCTION public."guardAccountingBatch"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  sum_debit BIGINT;
  sum_credit BIGINT;
  n_lines INTEGER;
  n_entries INTEGER;
  opening_net BIGINT;
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
    SELECT COALESCE(SUM(o."cents"), 0) INTO opening_net FROM "AccountingOpeningPosition" o WHERE o."batchId" = NEW."id";
    IF sum_debit <> sum_credit THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('Accounting batch guard: journals do not balance (debits %s, credits %s)', sum_debit, sum_credit);
    END IF;
    IF opening_net <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('Accounting batch guard: opening positions do not net to zero (%s)', opening_net);
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
