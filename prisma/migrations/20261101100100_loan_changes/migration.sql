-- CreateEnum
CREATE TYPE "LoanChangeType" AS ENUM ('RESCHEDULE', 'RESTRUCTURE', 'PAYMENT_HOLIDAY', 'RATE_CHANGE', 'TERM_CHANGE', 'TOP_UP', 'REFINANCE', 'CONSOLIDATION');


-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "restructuredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "loanChangeRequestId" TEXT;

-- AlterTable
ALTER TABLE "RepaymentSchedule" ADD COLUMN     "carriedFeesDue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "carriedInterestDue" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LoanTerms" ADD COLUMN     "changeRequestId" TEXT,
ALTER COLUMN "productVersionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LoanChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" "LoanChangeType" NOT NULL,
    "changeRequestId" TEXT NOT NULL,
    "makerId" TEXT NOT NULL,
    "checkerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "signedDocumentId" TEXT NOT NULL,
    "sourceLoanIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "newLoanId" TEXT,
    "settledCents" INTEGER NOT NULL DEFAULT 0,
    "newMoneyCents" INTEGER NOT NULL DEFAULT 0,
    "markedRestructured" BOOLEAN NOT NULL DEFAULT false,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "scheduleBefore" JSONB NOT NULL,
    "scheduleAfter" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanChange_changeRequestId_key" ON "LoanChange"("changeRequestId");

-- CreateIndex
CREATE INDEX "LoanChange_tenantId_loanId_idx" ON "LoanChange"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanChange_tenantId_id_key" ON "LoanChange"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoanChange_tenantId_newLoanId_key" ON "LoanChange"("tenantId", "newLoanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_loanChangeRequestId_key" ON "LoanApplication"("loanChangeRequestId");

-- AddForeignKey
ALTER TABLE "LoanChange" ADD CONSTRAINT "LoanChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanChange" ADD CONSTRAINT "LoanChange_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanChange" ADD CONSTRAINT "LoanChange_tenantId_newLoanId_fkey" FOREIGN KEY ("tenantId", "newLoanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Hand-written below: Prisma does not diff these. Rules: lib/loan-changes/.claude.md.

ALTER TABLE "LoanChange" ADD CONSTRAINT "LoanChange_values" CHECK (
  length(btrim("reason")) BETWEEN 5 AND 500
  AND "settledCents" >= 0 AND "newMoneyCents" >= 0
  AND ("type" IN ('TOP_UP', 'REFINANCE', 'CONSOLIDATION')) = ("newLoanId" IS NOT NULL)
  AND ("newLoanId" IS NOT NULL) = (cardinality("sourceLoanIds") > 0)
  AND ("newLoanId" IS NOT NULL OR ("settledCents" = 0 AND "newMoneyCents" = 0))
  AND ("newMoneyCents" = 0 OR "type" = 'TOP_UP')
  AND "makerId" <> "checkerId"
);

-- A terms row with no product version is the first row of a loan written before its product had one; only a change adds it.
ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_version_or_change" CHECK ("productVersionId" IS NOT NULL OR "changeRequestId" IS NOT NULL);

-- A change exists only because a second person approved exactly it, on a loan whose paper is the lender's own: an NCA_PASQ
-- loan's PASQ, agreement and debit order print its schedule, so nothing here may touch one. The row never changes or goes away.
CREATE OR REPLACE FUNCTION public."guardLoanChange"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  req RECORD;
  involved TEXT[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An applied loan change never changes or goes away: approve a new one';
  END IF;
  SELECT c."payload", c."makerId", c."checkerId" INTO req FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'LOAN_CHANGE' AND c."status" = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan change is applied only by an approved LOAN_CHANGE request';
  END IF;
  IF NEW."loanId" IS DISTINCT FROM req."payload" ->> 'loanId' OR NEW."type"::TEXT IS DISTINCT FROM req."payload" ->> 'type'
    OR NEW."signedDocumentId" IS DISTINCT FROM req."payload" ->> 'signedDocumentId'
    OR NEW."makerId" IS DISTINCT FROM req."makerId" OR NEW."checkerId" IS DISTINCT FROM req."checkerId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan change must be what its request approved';
  END IF;
  involved := array_append(NEW."sourceLoanIds", NEW."loanId");
  IF EXISTS (
    SELECT 1 FROM "Loan" l JOIN "LoanApplication" a ON a."id" = l."applicationId"
    WHERE l."tenantId" = NEW."tenantId" AND l."id" = ANY (involved) AND (a."disclosureRegime"::TEXT <> 'KEY_FACTS' OR l."contractType"::TEXT <> 'LOAN')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan change needs agreement wording that does not exist for an NCA or asset-finance loan';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ClientDocument" d JOIN "Loan" l ON l."clientId" = d."clientId" AND l."tenantId" = d."tenantId"
    WHERE d."id" = NEW."signedDocumentId" AND d."tenantId" = NEW."tenantId" AND l."id" = NEW."loanId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan change needs a signed document of the borrower';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanChange_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LoanChange"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanChange"();
CREATE TRIGGER "LoanChange_no_truncate" BEFORE TRUNCATE ON "LoanChange"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLoanChange"();

-- The changed loan reconciles to the cent when the transaction ends: its rows add up to its principal, interest and total.
CREATE OR REPLACE FUNCTION public."assertLoanChangeReconciles"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  target TEXT := COALESCE(NEW."newLoanId", NEW."loanId");
  loan RECORD;
  sums RECORD;
BEGIN
  SELECT l."principal", l."totalInterest", l."totalRepayable" INTO loan FROM "Loan" l WHERE l."id" = target AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE(SUM(s."principalDue"), 0) AS principal, COALESCE(SUM(s."interestDue"), 0) AS interest, COALESCE(SUM(s."totalDue"), 0) AS total,
    COALESCE(bool_or(s."principalDue" < 0 OR s."interestDue" < 0 OR s."feesDue" < 0 OR s."totalDue" <> s."principalDue" + s."interestDue" + s."feesDue"), false) AS broken
    INTO sums FROM "RepaymentSchedule" s WHERE s."loanId" = target AND s."tenantId" = NEW."tenantId";
  IF sums.broken OR sums.principal <> loan."principal" OR sums.interest <> loan."totalInterest" OR sums.total <> loan."totalRepayable" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'LoanChange_schedule_reconciles',
      MESSAGE = 'A changed loan''s schedule must add up to its principal, interest and total to the cent';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "LoanChange_schedule_reconciles" AFTER INSERT ON "LoanChange" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public."assertLoanChangeReconciles"();

-- Terms after the first come from an approved change, and a row with no version from one too (the CHECK above).
CREATE OR REPLACE FUNCTION public."guardLoanTerms"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  last INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The terms a loan was written on never change: a later change appends a row';
  END IF;
  SELECT COALESCE(MAX(t."sequence"), 0) INTO last FROM "LoanTerms" t WHERE t."tenantId" = NEW."tenantId" AND t."loanId" = NEW."loanId";
  IF NEW."sequence" <> last + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loan terms are appended in sequence: the next row for this loan is ' || (last + 1)::TEXT;
  END IF;
  IF (NEW."sequence" > 1 OR NEW."changeRequestId" IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'LOAN_CHANGE' AND c."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Later terms are appended only by an approved LOAN_CHANGE request';
  END IF;
  RETURN NEW;
END;
$function$;

-- The application of a new loan a change booked. Only an approved top-up, refinance or consolidation of that borrower names a
-- request, at insert, and it never changes; its paper is that request's signed document, so the key facts gate steps aside
-- for exactly these rows.
CREATE OR REPLACE FUNCTION public."guardLoanChangeApplication"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."loanChangeRequestId" IS DISTINCT FROM OLD."loanChangeRequestId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The loan change that booked an application never changes';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."loanChangeRequestId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."disclosureRegime"::TEXT <> 'KEY_FACTS' OR NOT EXISTS (
    SELECT 1 FROM "ChangeRequest" c JOIN "ClientDocument" d ON d."id" = c."payload" ->> 'signedDocumentId' AND d."tenantId" = c."tenantId"
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."loanChangeRequestId" AND c."kind" = 'LOAN_CHANGE' AND c."status" = 'APPROVED'
      AND c."payload" ->> 'type' IN ('TOP_UP', 'REFINANCE', 'CONSOLIDATION') AND d."clientId" = NEW."clientId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an approved top-up, refinance or consolidation of this borrower books a loan this way';
  END IF;
  RETURN NEW;
END;
$function$;
-- a01: after a00 stamps the disclosure regime.
CREATE TRIGGER "LoanApplication_a01_guard_loan_change" BEFORE INSERT OR UPDATE OF "loanChangeRequestId" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanChangeApplication"();
DROP TRIGGER "LoanApplication_z_guard_key_facts_documents" ON "LoanApplication";
CREATE TRIGGER "LoanApplication_z_guard_key_facts_documents" BEFORE UPDATE OF "status", "agreementSignedAt" ON "LoanApplication" FOR EACH ROW
  WHEN (NEW."disclosureRegime" = 'KEY_FACTS' AND NEW."loanChangeRequestId" IS NULL) EXECUTE FUNCTION public."guardLoanApplicationKeyFactsDocuments"();

-- A LOAN_SETTLEMENT receipt is written only for a loan an applied change settled, and stands: reversing it would reopen a loan
-- whose balance now sits in the new one. Its charge split may still be rewritten by the replay.
CREATE OR REPLACE FUNCTION public."guardLoanSettlementReceipt"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "LoanChange" c WHERE c."tenantId" = NEW."tenantId" AND NEW."loanId" = ANY (c."sourceLoanIds")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A settlement by a new loan is written only for a loan an approved change settled';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod" OR NEW."reversed" IS DISTINCT FROM OLD."reversed" OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."allocationStatus" IS DISTINCT FROM OLD."allocationStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A settlement by a new loan stands: it is never reversed or changed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Payment_loan_settlement_insert" BEFORE INSERT ON "Payment" FOR EACH ROW
  WHEN (NEW."paymentMethod"::TEXT = 'LOAN_SETTLEMENT') EXECUTE FUNCTION public."guardLoanSettlementReceipt"();
CREATE TRIGGER "Payment_loan_settlement_update" BEFORE UPDATE ON "Payment" FOR EACH ROW
  WHEN (OLD."paymentMethod"::TEXT = 'LOAN_SETTLEMENT' OR NEW."paymentMethod"::TEXT = 'LOAN_SETTLEMENT') EXECUTE FUNCTION public."guardLoanSettlementReceipt"();

-- Tenant isolation (as 20261031120000_product_engine) ---------------------------

ALTER TABLE "LoanChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanChange" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanChange" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
