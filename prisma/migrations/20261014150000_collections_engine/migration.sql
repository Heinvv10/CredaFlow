-- Collections engine (W2): DebiCheck / debit-order mandates, batches,
-- instructions and results. Adds enforcement (CHECKs, partial unique indexes,
-- triggers): ship with the code in lib/collections-engine, never ahead of it.

-- CreateEnum
CREATE TYPE "DebitMandateStatus" AS ENUM ('CREATED', 'PENDING_AUTH', 'ACTIVE', 'REJECTED', 'EXPIRED', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DebitMandateAuthType" AS ENUM ('TT1', 'TT1_DELAYED', 'TT2');

-- CreateEnum
CREATE TYPE "DebitMandateFrequency" AS ENUM ('ONCE_OFF', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DebitMandateAdjustment" AS ENUM ('NEVER', 'QUARTERLY', 'BIANNUALLY', 'ANNUALLY', 'REPO_RATE');

-- CreateEnum
CREATE TYPE "CollectionBatchStatus" AS ENUM ('SUBMITTING', 'SUBMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CollectionInstructionStatus" AS ENUM ('PENDING', 'SUBMITTING', 'SUBMITTED', 'REJECTED', 'CANCELLED', 'PAID', 'UNPAID', 'DISPUTED');

-- CreateEnum
CREATE TYPE "CollectionResultOutcome" AS ENUM ('PAID', 'UNPAID', 'DISPUTED');

-- CreateEnum
CREATE TYPE "CollectionReasonCode" AS ENUM ('INSUFFICIENT_FUNDS', 'ACCOUNT_CLOSED', 'PAYMENT_STOPPED', 'MANDATE_SUSPENDED', 'MANDATE_CANCELLED', 'ACCOUNT_FROZEN', 'NO_DEBIT_FACILITY', 'NOT_FICA', 'UNKNOWN');

-- CreateTable
CREATE TABLE "DebitMandate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMandateRef" TEXT,
    "authType" "DebitMandateAuthType" NOT NULL,
    "status" "DebitMandateStatus" NOT NULL DEFAULT 'CREATED',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountCents" INTEGER NOT NULL,
    "maxAmountCents" INTEGER NOT NULL,
    "debitDay" INTEGER NOT NULL,
    "frequency" "DebitMandateFrequency" NOT NULL,
    "adjustment" "DebitMandateAdjustment" NOT NULL DEFAULT 'NEVER',
    "trackingDays" INTEGER NOT NULL,
    "firstCollectionDate" DATE NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebitMandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerBatchRef" TEXT,
    "actionDate" DATE NOT NULL,
    "status" "CollectionBatchStatus" NOT NULL DEFAULT 'SUBMITTING',
    "instructionCount" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionInstruction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "repaymentScheduleId" TEXT NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "presentmentNo" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "actionDate" DATE NOT NULL,
    "trackingDays" INTEGER NOT NULL,
    "instructionRef" TEXT NOT NULL,
    "status" "CollectionInstructionStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "batchId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "instructionId" TEXT NOT NULL,
    "resultKey" TEXT NOT NULL,
    "outcome" "CollectionResultOutcome" NOT NULL,
    "reasonCode" "CollectionReasonCode",
    "rawCode" TEXT,
    "rawPayload" JSONB NOT NULL,
    "settledAmountCents" INTEGER,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "paymentId" TEXT,
    "processedAt" TIMESTAMP(3),
    "allocationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DebitMandate_tenantId_loanId_idx" ON "DebitMandate"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "DebitMandate_tenantId_status_idx" ON "DebitMandate"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DebitMandate_tenantId_id_key" ON "DebitMandate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DebitMandate_tenantId_provider_providerMandateRef_key" ON "DebitMandate"("tenantId", "provider", "providerMandateRef");

-- CreateIndex
CREATE INDEX "CollectionBatch_tenantId_createdAt_idx" ON "CollectionBatch"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBatch_tenantId_id_key" ON "CollectionBatch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBatch_tenantId_provider_providerBatchRef_key" ON "CollectionBatch"("tenantId", "provider", "providerBatchRef");

-- CreateIndex
CREATE INDEX "CollectionInstruction_tenantId_status_actionDate_idx" ON "CollectionInstruction"("tenantId", "status", "actionDate");

-- CreateIndex
CREATE INDEX "CollectionInstruction_tenantId_loanId_idx" ON "CollectionInstruction"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "CollectionInstruction_mandateId_idx" ON "CollectionInstruction"("mandateId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionInstruction_tenantId_id_key" ON "CollectionInstruction"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionInstruction_tenantId_instructionRef_key" ON "CollectionInstruction"("tenantId", "instructionRef");

-- CreateIndex
CREATE INDEX "CollectionResult_tenantId_instructionId_idx" ON "CollectionResult"("tenantId", "instructionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionResult_tenantId_id_key" ON "CollectionResult"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionResult_tenantId_provider_resultKey_key" ON "CollectionResult"("tenantId", "provider", "resultKey");

-- CreateIndex
CREATE UNIQUE INDEX "RepaymentSchedule_tenantId_id_key" ON "RepaymentSchedule"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "DebitMandate" ADD CONSTRAINT "DebitMandate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitMandate" ADD CONSTRAINT "DebitMandate_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DebitMandate" ADD CONSTRAINT "DebitMandate_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DebitMandate" ADD CONSTRAINT "DebitMandate_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionBatch" ADD CONSTRAINT "CollectionBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tenantId_mandateId_fkey" FOREIGN KEY ("tenantId", "mandateId") REFERENCES "DebitMandate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tenantId_repaymentScheduleId_fkey" FOREIGN KEY ("tenantId", "repaymentScheduleId") REFERENCES "RepaymentSchedule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "CollectionBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionResult" ADD CONSTRAINT "CollectionResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionResult" ADD CONSTRAINT "CollectionResult_tenantId_instructionId_fkey" FOREIGN KEY ("tenantId", "instructionId") REFERENCES "CollectionInstruction"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CollectionResult" ADD CONSTRAINT "CollectionResult_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written: the scheme rules the database enforces ────────────────────
-- Same numbers as lib/collections-engine/scheme-rules.ts (the static test
-- lib/collections-engine/migration.test.ts holds the two together). They are
-- taken from published DebiCheck scheme summaries and must be verified against
-- the provider's rulebook before go-live.

ALTER TABLE "DebitMandate" ADD CONSTRAINT "DebitMandate_terms_valid" CHECK (
  "amountCents" > 0
  AND "maxAmountCents" >= "amountCents"
  AND "debitDay" BETWEEN 1 AND 31
  AND "trackingDays" BETWEEN 1 AND 10
);

-- One live mandate per loan: a second would debit the same instalment twice.
-- A SUSPENDED mandate is not live; it is replaced by a fresh one.
CREATE UNIQUE INDEX "DebitMandate_one_live_per_loan" ON "DebitMandate"("tenantId", "loanId")
  WHERE "status" IN ('CREATED', 'PENDING_AUTH', 'ACTIVE');

-- A mandate is born CREATED and only moves forward. SUSPENDED never returns to
-- ACTIVE (after two consecutive unpaids the scheme requires a fresh mandate).
-- The terms the debtor authorises are fixed once the row exists.
CREATE FUNCTION "guardDebitMandateStatus"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'DebitMandate % must be created in status CREATED, not %', NEW.id, NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."loanId", NEW."clientId", NEW.provider, NEW."authType", NEW."amountCents",
      NEW."maxAmountCents", NEW."debitDay", NEW.frequency, NEW.adjustment, NEW."trackingDays",
      NEW."firstCollectionDate", NEW."accountHolder", NEW."bankName", NEW."branchCode",
      NEW."accountNumber", NEW."accountType", NEW."createdById")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."loanId", OLD."clientId", OLD.provider, OLD."authType", OLD."amountCents",
      OLD."maxAmountCents", OLD."debitDay", OLD.frequency, OLD.adjustment, OLD."trackingDays",
      OLD."firstCollectionDate", OLD."accountHolder", OLD."bankName", OLD."branchCode",
      OLD."accountNumber", OLD."accountType", OLD."createdById") THEN
    RAISE EXCEPTION 'DebitMandate % terms are fixed once created: create a fresh mandate', NEW.id;
  END IF;
  IF OLD."providerMandateRef" IS NOT NULL AND NEW."providerMandateRef" IS DISTINCT FROM OLD."providerMandateRef" THEN
    RAISE EXCEPTION 'DebitMandate % provider reference is fixed once assigned', NEW.id;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'CREATED' AND NEW.status IN ('PENDING_AUTH', 'ACTIVE', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'PENDING_AUTH' AND NEW.status IN ('ACTIVE', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'CANCELLED'))
    OR (OLD.status = 'SUSPENDED' AND NEW.status = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'DebitMandate % cannot move from % to %', NEW.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DebitMandate_guard_status" BEFORE INSERT OR UPDATE ON "DebitMandate"
  FOR EACH ROW EXECUTE FUNCTION "guardDebitMandateStatus"();

-- Scheme rule: at most two presentments of one instalment per cycle (one
-- mandate). Bank-level tracking retries inside trackingDays are not presentments.
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_presentment_cap"
  CHECK ("presentmentNo" BETWEEN 1 AND 2);
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_amount_positive"
  CHECK ("amountCents" > 0);
ALTER TABLE "CollectionInstruction" ADD CONSTRAINT "CollectionInstruction_tracking_days"
  CHECK ("trackingDays" BETWEEN 1 AND 10);

-- Each presentment number once per instalment per mandate. A CANCELLED
-- instruction never reached the bank and frees its number.
CREATE UNIQUE INDEX "CollectionInstruction_presentment_once"
  ON "CollectionInstruction"("mandateId", "repaymentScheduleId", "presentmentNo")
  WHERE "status" <> 'CANCELLED';

-- One instruction per instalment in flight at a time.
CREATE UNIQUE INDEX "CollectionInstruction_one_open_per_instalment"
  ON "CollectionInstruction"("repaymentScheduleId")
  WHERE "status" IN ('PENDING', 'SUBMITTING', 'SUBMITTED');

-- An instruction is created only against an ACTIVE mandate of the same loan,
-- for an instalment of that loan, within the mandate's maximum amount. AFTER
-- INSERT, so a third presentment is refused by the cap CHECK, which runs first.
CREATE FUNCTION "guardCollectionInstructionMandate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m RECORD;
BEGIN
  SELECT status, "loanId", "maxAmountCents" INTO m
    FROM "DebitMandate"
    WHERE id = NEW."mandateId" AND "tenantId" = NEW."tenantId"
    FOR SHARE;
  IF m.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'CollectionInstruction % refused: mandate % is %, not ACTIVE', NEW.id, NEW."mandateId", coalesce(m.status::text, 'missing');
  END IF;
  IF m."loanId" <> NEW."loanId" THEN
    RAISE EXCEPTION 'CollectionInstruction % refused: mandate % belongs to another loan', NEW.id, NEW."mandateId";
  END IF;
  IF NEW."amountCents" > m."maxAmountCents" THEN
    RAISE EXCEPTION 'CollectionInstruction % refused: amount exceeds the mandate maximum', NEW.id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "RepaymentSchedule" s
    WHERE s.id = NEW."repaymentScheduleId" AND s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'CollectionInstruction % refused: instalment is not on loan %', NEW.id, NEW."loanId";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "CollectionInstruction_require_active_mandate" AFTER INSERT ON "CollectionInstruction"
  FOR EACH ROW EXECUTE FUNCTION "guardCollectionInstructionMandate"();

ALTER TABLE "CollectionResult" ADD CONSTRAINT "CollectionResult_paid_has_amount"
  CHECK ("outcome" <> 'PAID' OR "settledAmountCents" > 0);
ALTER TABLE "CollectionResult" ADD CONSTRAINT "CollectionResult_payment_only_when_paid"
  CHECK ("paymentId" IS NULL OR "outcome" = 'PAID');

-- A receipt is booked for one collection result only.
CREATE UNIQUE INDEX "CollectionResult_payment_once" ON "CollectionResult"("paymentId")
  WHERE "paymentId" IS NOT NULL;
