-- W6 review round 3 (PR #89).
--  1. A provider's late PAID report on an attempt of a loan whose disbursement
--     was already reversed is never "resolved as paid": the loan stays
--     CANCELLED and the money becomes a PayoutRecoveryCase
--     (lib/payouts/recovery.ts), OPEN -> ESCALATED -> RECOVERED.
--  2. An approved reversal carries a "cancel the debit order by hand" staff
--     task until someone acknowledges it (no mandate register on this build).
-- Exercised by lib/payouts/payout-recovery.integration.test.ts.

-- CreateEnum
CREATE TYPE "PayoutRecoveryStatus" AS ENUM ('OPEN', 'ESCALATED', 'RECOVERED');

-- AlterTable
ALTER TABLE "DisbursementReversal" ADD COLUMN     "debitOrderCancelAckAt" TIMESTAMP(3),
ADD COLUMN     "debitOrderCancelAckById" TEXT;

-- CreateTable
CREATE TABLE "PayoutRecoveryCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "status" "PayoutRecoveryStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT NOT NULL,
    "openNote" TEXT NOT NULL,
    "escalatedAt" TIMESTAMP(3),
    "escalatedById" TEXT,
    "escalationNote" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "recoveredById" TEXT,
    "recoveryNote" TEXT,
    "recoveryReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutRecoveryCase_payoutId_key" ON "PayoutRecoveryCase"("payoutId");

-- CreateIndex
CREATE INDEX "PayoutRecoveryCase_tenantId_status_idx" ON "PayoutRecoveryCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PayoutRecoveryCase_tenantId_loanId_idx" ON "PayoutRecoveryCase"("tenantId", "loanId");

-- AddForeignKey
ALTER TABLE "PayoutRecoveryCase" ADD CONSTRAINT "PayoutRecoveryCase_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayoutRecoveryCase" ADD CONSTRAINT "PayoutRecoveryCase_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "DisbursementPayout"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A payout of a reversed loan never becomes PAID: that money is a recovery case.
CREATE OR REPLACE FUNCTION public."guardPayoutPaidOnReversedLoan"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."status" = 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: this loan''s disbursement was reversed; money paid out on it is a recovery case, not a paid payout';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardPayoutPaidOnReversedLoan"
  BEFORE UPDATE OF "status" ON "DisbursementPayout"
  FOR EACH ROW
  WHEN (NEW."status" = 'PAID' AND OLD."status" IS DISTINCT FROM 'PAID')
  EXECUTE FUNCTION public."guardPayoutPaidOnReversedLoan"();

CREATE OR REPLACE FUNCTION public."guardPayoutRecoveryCase"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  p "DisbursementPayout"%ROWTYPE;
  actor TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: a recovery case is never deleted';
  END IF;
  SELECT * INTO p FROM "DisbursementPayout" WHERE "id" = NEW."payoutId";
  IF TG_OP = 'INSERT' THEN
    IF p."id" IS NULL OR p."tenantId" <> NEW."tenantId" OR p."loanId" <> NEW."loanId"
      OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."status" = 'CANCELLED')
      OR p."status" NOT IN ('FAILED', 'CANCELLED')
      OR p."providerConflictState" IS DISTINCT FROM 'PAID'
      OR p."conflictResolvedAt" IS NULL
      OR p."conflictResolvedById" IS DISTINCT FROM NEW."openedById"
      OR NEW."amountCents" IS DISTINCT FROM p."amountCents"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: a case opens only on a resolved provider PAID report, by its resolver, for an attempt of a reversed loan, for the attempt''s amount';
    END IF;
    IF NEW."status" <> 'OPEN' OR NEW."escalatedAt" IS NOT NULL OR NEW."escalatedById" IS NOT NULL
      OR NEW."recoveredAt" IS NOT NULL OR NEW."recoveredById" IS NOT NULL OR length(trim(NEW."openNote")) < 5
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: a case opens OPEN, with a note';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."loanId" IS DISTINCT FROM OLD."loanId"
    OR NEW."payoutId" IS DISTINCT FROM OLD."payoutId" OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt" OR NEW."openedById" IS DISTINCT FROM OLD."openedById"
    OR NEW."openNote" IS DISTINCT FROM OLD."openNote" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: the facts a case was opened on never change';
  END IF;
  IF OLD."status" = 'RECOVERED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: a recovered case is closed';
  END IF;
  IF OLD."status" = 'OPEN' AND NEW."status" = 'ESCALATED' THEN
    IF NEW."escalatedAt" IS NULL OR NEW."escalatedById" IS NULL OR length(trim(coalesce(NEW."escalationNote", ''))) < 5
      OR NEW."recoveredAt" IS NOT NULL OR NEW."recoveredById" IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: an escalation names who, when and why';
    END IF;
    actor := NEW."escalatedById";
  ELSIF NEW."status" = 'RECOVERED' THEN
    IF NEW."recoveredAt" IS NULL OR NEW."recoveredById" IS NULL OR length(trim(coalesce(NEW."recoveryNote", ''))) < 5
      OR NEW."recoveredAt" < OLD."paidAt"
      OR NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt" OR NEW."escalatedById" IS DISTINCT FROM OLD."escalatedById"
      OR NEW."escalationNote" IS DISTINCT FROM OLD."escalationNote"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: a recovery names who, when (not before the money left) and how';
    END IF;
    actor := NEW."recoveredById";
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: a case goes OPEN -> ESCALATED -> RECOVERED, or OPEN -> RECOVERED';
  END IF;
  IF actor IN (p."disbursedById", p."createdById", coalesce(p."approvedById", '')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: someone other than the people who made or approved this payout acts on its recovery';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardPayoutRecoveryCase"
  BEFORE INSERT OR UPDATE OR DELETE ON "PayoutRecoveryCase"
  FOR EACH ROW EXECUTE FUNCTION public."guardPayoutRecoveryCase"();

-- 20261015190000 version, plus: an APPROVED reversal may take its debit-order
-- acknowledgement once, and nothing else ever changes after the decision.
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
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'REQUESTED' THEN
    IF OLD."status" = 'APPROVED' AND OLD."debitOrderCancelAckAt" IS NULL
      AND NEW."debitOrderCancelAckAt" IS NOT NULL AND NEW."debitOrderCancelAckById" IS NOT NULL
      AND (to_jsonb(NEW) - 'debitOrderCancelAckAt' - 'debitOrderCancelAckById')
        = (to_jsonb(OLD) - 'debitOrderCancelAckAt' - 'debitOrderCancelAckById')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a request is decided once and never changes';
  END IF;
  IF NEW."debitOrderCancelAckAt" IS NOT NULL OR NEW."debitOrderCancelAckById" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: the debit order is acknowledged cancelled only after the reversal is approved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId")
    OR EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId"
      AND p."status" NOT IN ('FAILED', 'RETURNED', 'CANCELLED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a disbursement is reversed only when every payout attempt failed, was returned or was cancelled';
  END IF;
  IF NEW."status" <> 'REJECTED' AND EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId"
    AND p."providerConflictAt" IS NOT NULL AND p."conflictResolvedAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Reversal guard: a provider reported money moving on an attempt already over; resolve that first';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Reversal guard: a reversal is created as an undecided request';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" NOT IN ('APPROVED', 'REJECTED')
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
