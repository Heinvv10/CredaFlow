# Consolidated goal §8 migration confirmation proposal

**Approved by Hein on 2026-10-18: “approved. cont”.** This extends the earlier
surrender-index-only approval to this consolidated proposal and the three linked
CPA/total-loss/zero-rental proposals. No shared database has been changed. Proposed baseline replacements were
previously tested in disposable local databases before the scope audit; those
tests do not supply approval. No further baseline replacement has been applied
since the audit hold. PR-new object refinements were tested separately on an
already owned disposable database, now removed.

This is exact proposed SQL against main `45609da5` (PR176, already merged).
NCA and LEASE own their migration files; RATE repeats are omitted because the
inherited files ship once through the owning PR. D must integrate the final A/B
files before its fresh migration/full gate. No applied shared migration is edited.
No rows, tables or columns are deleted.

## Review summary

| Owner | Existing object | Required behavior |
|---|---|---|
| A | SurrenderRequest partial unique index | Previously approved WITHDRAWN terminal-state exemption. |
| A | guardSurrenderRequest / guardRecovery | Evidenced withdrawal, receipt-based sale timing, linked surrender and actual surplus remittance/closure. |
| B | LeaseTerminationQuote amounts / termination-window CHECKs | CPA/unilateral/loss figures and actual historical loss dates, retaining arithmetic and evidence protections. |
| B | Lease termination/rental/cancellation/maintenance guards | Statutory continuation, cancel unmade supplies with tax credits, preserve actual cash and approved maintenance credits. |
| B | guardLeaseEndOfTerm | Evidenced TOTAL_LOSS closure without fictitious return/inspection; terminal unavailable asset and actual refund evidence. |
| B | guardRecovery (two exact anchors) | Reasoned CPA net-charge allowance and receipt, preserving original vendor expenses/BANK, single proceeds and genuine surplus. Current installed function is patched narrowly so A protections remain. |
| D | validateLoanPasqV3Billing | Authenticate asset-only corrections against frozen approved PASQ; ordinary consumer LOAN unchanged. |
| D | LeaseRental_amounts CHECK | Only rental > 0 becomes >= 0 after payoff; all other predicates preserved. |

Additional exact proposals and acceptance requirements:

- `2026-10-17-legal-zero-rental-gate.md`: CHECK replacement (still not in runnable migrations).
- `2026-10-18-lease-total-loss-gate-proposal.md`: exact closure, asset and refund SQL.
- `2026-10-18-cpa-lessor-assessment-gate-proposal.md`: exact assessment/concession/receipt SQL.

At approval, all new gated closure/concession/zero-floor PostgreSQL cases were unrun.
Fresh execution has resumed; current results are recorded in the review handoff.
Candidate source and unit/type checks are reviewable; no whole-A/B/D acceptance
is claimed. Required after approval: fresh complete migrations on disposable
PG16, B-only and A+B union guard proofs, all new real-flow and mutation tests,
source integration, full CI, independent reviews/edge acceptance, and mq merge.

Approval authorizes only these listed new migrations with their code and
verification. It excludes consumer PASQ output/pin changes, lender legal flags,
deployments or demo/Fairscore changes, real messages/payments, and spending.

## Exact SQL appendix

## NCA — source checkpoint 0a0db993

### prisma/migrations/20261017180100_nca_surrender_legal_guards/migration.sql

Existing functions changed: `guardSurrenderRequest`, `guardRecovery`.

Exact proposed SQL:

```sql
-- New migration; index replacement approved by Hein 2026-10-17.
BEGIN;
ALTER TABLE "SurrenderRequest"
 ADD COLUMN "valuationNoticeIssuedOn" DATE,
 ADD COLUMN "valuationNoticeReceivedOn" DATE,
 ADD COLUMN "valuationReceiptReference" TEXT,
 ADD COLUMN "goodsReturnedOn" DATE,
 ADD COLUMN "goodsReturnReference" TEXT,
 ADD COLUMN "chargesFrozenFrom" DATE,
 ADD COLUMN "chargesFrozenUntil" DATE;
ALTER TABLE "Recovery"
 ADD COLUMN "valuationNoticeIssuedOn" DATE,
 ADD COLUMN "valuationNoticeReceivedOn" DATE,
 ADD COLUMN "valuationReceiptReference" TEXT;
CREATE UNIQUE INDEX "SurrenderRequest_one_live_per_loan" ON "SurrenderRequest"("loanId")
 WHERE "status" NOT IN ('FINAL_NOTICE_ISSUED', 'WITHDRAWN');
DROP INDEX "SurrenderRequest_one_open_per_loan";
ALTER INDEX "SurrenderRequest_one_live_per_loan" RENAME TO "SurrenderRequest_one_open_per_loan";
CREATE OR REPLACE FUNCTION public."guardSurrenderRequest"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE valuation RECORD; payment RECORD; loan_row RECORD; receipt_total INTEGER; today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date; changed TEXT[]; allowed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A voluntary-surrender record is never deleted'; END IF;
  SELECT l."ncaRegime", l."contractType", l."assetId", l."status", l."outstandingPrincipal", l."chargesOutstanding", l."arrearsAmount"
  INTO loan_row FROM "Loan" l WHERE l."id"=NEW."loanId" AND l."tenantId"=NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row."ncaRegime" <> 'NCA' OR loan_row."contractType" = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Voluntary surrender belongs to an NCA asset-finance loan and its financed asset';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference",NEW."goodsReturnedOn",NEW."goodsReturnReference",NEW."chargesFrozenFrom",NEW."chargesFrozenUntil")>0 OR NEW."status" <> 'REQUESTED' OR loan_row."status" NOT IN ('ACTIVE','DEFAULTED') OR NEW."valuationId" IS NOT NULL OR NEW."valuationNoticePath" IS NOT NULL OR NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surrender opens REQUESTED on an active or defaulted NCA asset loan without later evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id",NEW."tenantId",NEW."loanId",NEW."assetId",NEW."requestedByType",NEW."requestedById",NEW."requestedOn",NEW."assetCondition",NEW."valuationDueOn")
    IS DISTINCT FROM (OLD."id",OLD."tenantId",OLD."loanId",OLD."assetId",OLD."requestedByType",OLD."requestedById",OLD."requestedOn",OLD."assetCondition",OLD."valuationDueOn") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender request and statutory deadline are immutable';
  END IF;
  IF OLD."status" IN ('WITHDRAWN','FINAL_NOTICE_ISSUED') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A closed surrender is immutable';
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status','updatedAt'));
  IF NEW."status" = 'WITHDRAWN' THEN
    IF loan_row."status"='DEFAULTED' OR loan_row."arrearsAmount">0 OR EXISTS(
        SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId"=NEW."loanId" AND r."totalDue">r."totalPaid" AND (r."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date<today)
      OR OLD."status" NOT IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED') OR OLD."valuationNoticeReceivedOn" IS NULL
      OR today > public."recoveryAddBusinessDays"(OLD."valuationNoticeReceivedOn",10)
      OR NEW."goodsReturnedOn" IS DISTINCT FROM today OR length(btrim(COALESCE(NEW."goodsReturnReference",''))) < 10
      OR EXISTS (SELECT 1 FROM "Recovery" r JOIN "RemarketingSale" s ON s."recoveryId"=r."id"
        WHERE r."surrenderRequestId"=NEW."id" AND s."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal within ten business days requires return of unsold goods';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(changed) k WHERE k NOT IN ('goodsReturnedOn','goodsReturnReference')) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal changes only the goods return evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status" THEN
    IF OLD."status" NOT IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED') OR OLD."valuationNoticeReceivedOn" IS NOT NULL
      OR EXISTS (SELECT 1 FROM unnest(changed) k WHERE k NOT IN ('valuationNoticeIssuedOn','valuationNoticeReceivedOn','valuationReceiptReference')) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only valuation receipt evidence may be recorded once without a surrender step';
    END IF;
  ELSIF (OLD."status",NEW."status") NOT IN (
    ('REQUESTED','VALUED'),('VALUED','VALUATION_NOTICE_ISSUED'),('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED'),('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED')
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender follows request, valuation, valuation notice, proceeds and final notice in order'; END IF;
  IF OLD."status" <> NEW."status" THEN
    allowed := CASE NEW."status"::TEXT
      WHEN 'VALUED' THEN ARRAY['valuationId']
      WHEN 'VALUATION_NOTICE_ISSUED' THEN ARRAY['valuationNoticePath','valuationNoticeSha256']
      WHEN 'PROCEEDS_CREDITED' THEN ARRAY['saleProceedsCents','proceedsPaymentId','shortfallCents','refundCents']
      WHEN 'FINAL_NOTICE_ISSUED' THEN ARRAY['finalNoticePath','finalNoticeSha256']
      ELSE ARRAY[]::TEXT[] END;
    IF EXISTS (SELECT 1 FROM unnest(changed) k WHERE k <> ALL(allowed)) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surrender valuation, notices, proceeds and freeze are write-once';
    END IF;
  END IF;
  IF NEW."status" = 'VALUATION_NOTICE_ISSUED' AND OLD."status" = 'VALUED' THEN NEW."valuationNoticeIssuedOn" := today; END IF;
  IF NEW."valuationNoticeIssuedOn" IS DISTINCT FROM OLD."valuationNoticeIssuedOn"
      AND NOT (OLD."status"='VALUED' AND NEW."status"='VALUATION_NOTICE_ISSUED')
      AND NOT (OLD."status"=NEW."status" AND OLD."status"::text IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','LISTED','SOLD','PROCEEDS_APPLIED') AND OLD."valuationNoticePath" IS NOT NULL
        AND OLD."valuationNoticeIssuedOn" IS NULL AND OLD."valuationNoticeReceivedOn" IS NULL
        AND NEW."valuationNoticeIssuedOn" IS NOT NULL AND NEW."valuationNoticeReceivedOn" IS NOT NULL
        AND length(btrim(COALESCE(NEW."valuationReceiptReference",'')))>=10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notice issue date is immutable except once with historical issue and receipt evidence';
  END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
    OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
    OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF NEW."status" IN ('VALUED','VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN
    SELECT * INTO valuation FROM "AssetValuation" v WHERE v."id"=NEW."valuationId" AND v."tenantId"=NEW."tenantId" AND v."assetId"=NEW."assetId";
    IF NOT FOUND OR valuation."valuedOn" < NEW."requestedOn" OR valuation."valuedOn" > NEW."valuationDueOn" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The s127 valuation must be for this asset within the recorded statutory window';
    END IF;
  END IF;
  IF NEW."status" IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') AND NEW."valuationNoticePath" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The valuation notice bytes and digest are required';
  END IF;
  IF NEW."status" IN ('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN
    SELECT p."amount",p."allocationStatus",p."reversed",p."loanId",p."receivedAt" INTO payment FROM "Payment" p WHERE p."id"=NEW."proceedsPaymentId" AND p."tenantId"=NEW."tenantId";
    SELECT payment."amount" + COALESCE(sum(child."amount"),0) INTO receipt_total
    FROM "Payment" child WHERE child."parentPaymentId"=NEW."proceedsPaymentId" AND NOT child."reversed";
    IF NOT FOUND OR payment."loanId"<>NEW."loanId" OR payment."reversed" OR payment."allocationStatus" NOT IN ('ALLOCATED','UNAPPLIED') OR receipt_total<>NEW."saleProceedsCents" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Sale proceeds must be the exact live receipt credited to this loan';
    END IF;
    IF num_nulls(NEW."shortfallCents",NEW."refundCents")>0 OR (NEW."shortfallCents">0 AND NEW."refundCents">0) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Proceeds record one non-negative shortfall and refund result';
    END IF;
  END IF;
  IF NEW."status" = 'FINAL_NOTICE_ISSUED' AND NEW."finalNoticePath" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The final s127 notice bytes and digest are required';
  END IF;
  IF NEW."status" = 'PROCEEDS_CREDITED' AND OLD."status" <> NEW."status" THEN
    NEW."chargesFrozenFrom" := (payment."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date;
    NEW."chargesFrozenUntil" := NULL;
  END IF;
  IF NEW."status" = 'FINAL_NOTICE_ISSUED' THEN
    NEW."chargesFrozenUntil" := public."recoveryAddBusinessDays"(today,10);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRecovery"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  surrender RECORD;
  config RECORD;
  costs RECORD;
  nca BOOLEAN;
  step TEXT;
  allowed TEXT[];
  changed TEXT[];
  expected_receipt INTEGER;
  receipt_total INTEGER;
  sale_price INTEGER;
  sale_day DATE;
  live_status TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is never deleted';
  END IF;
  nca := NEW."route" IN ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT');
  SELECT l."ncaRegime"::TEXT AS regime, l."contractType"::TEXT AS contract_type, l."assetId", l."status"::TEXT AS status INTO loan_row
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row.contract_type = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery belongs to an asset-finance loan and its financed asset';
  END IF;
  IF nca <> (loan_row.regime = 'NCA') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The recovery route must match the loan''s NCA regime';
  END IF;
  IF NEW."meterReadingId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."meterReadingId" IS DISTINCT FROM OLD."meterReadingId") AND NOT EXISTS (
      SELECT 1 FROM "AssetMeterReading" r WHERE r."id" = NEW."meterReadingId" AND r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s meter reading is its own asset''s';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")>0 OR NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    -- Locks, in this order, on the rows the checks below read, so a concurrent booking, completion or credit cannot slip
    -- between the check and the commit (READ COMMITTED): the loan (FOR SHARE: its status cannot change under us), the
    -- asset (FOR UPDATE: it conflicts with the key-share lock a Loan insert takes through its foreign key, and with the
    -- Loan guard's share lock) and the surrender (FOR UPDATE: a credit of it waits, then sees this recovery).
    SELECT l."status"::TEXT INTO live_status FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;
    IF live_status NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened on an active, defaulted or pending write-off loan';
    END IF;
    -- the asset's lessor status before the recovery: none, or the stock a lease returned (a re-leased asset is recovered too)
    SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
    -- the loan that holds the asset now: an asset a lease returned and a new lease took is the new lease's
    IF EXISTS (SELECT 1 FROM "Loan" o WHERE o."tenantId" = NEW."tenantId" AND o."assetId" = NEW."assetId" AND o."id" <> NEW."loanId"
        AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'WRITTEN_OFF')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened by the loan that holds the asset now';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NEW."surrenderRequestId" IS NOT NULL THEN
      PERFORM 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows a surrender that has not yet been credited or finally noticed';
      END IF;
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."status" <> 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery stands on an open legal matter';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA court-order recovery needs the legal matter''s judgment';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CLOSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed or withdrawn recovery is final';
  END IF;
  -- The columns this step may write. Everything else is fixed: the loan, asset, route, surrender,
  -- legal matter, date and creator from the start, and the valuation, notices, figures, payment and
  -- freeze dates once written, because each is written by exactly one step.
  step := OLD."status"::TEXT || '>' || NEW."status"::TEXT;
  IF OLD."status" = NEW."status" THEN
    allowed := ARRAY['location', 'condition', 'meterReadingId', 'valuationNoticeIssuedOn', 'valuationNoticeReceivedOn', 'valuationReceiptReference'];
    -- once the proceeds are applied, the costs the ledger could not carry are recorded: NULL to a value, in this status only
    IF OLD."status" = 'PROCEEDS_APPLIED' AND OLD."unrecoverableCostsCents" IS NULL THEN
      allowed := allowed || ARRAY['unrecoverableCostsCents'];
    END IF;
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256', 'valuationNoticeIssuedOn'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil', 'unrecoverableCostsCents'];
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    allowed := ARRAY['finalNoticeIssuedOn', 'finalNoticePath', 'finalNoticeSha256', 'chargesFrozenUntil'];
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED', 'SHORTFALL_OPEN>CLOSED', 'SURPLUS_HELD>CLOSED') THEN
    allowed := ARRAY['closedAt'];
  ELSIF step IN ('RECOVERED>WITHDRAWN', 'VALUED>WITHDRAWN', 'VALUATION_NOTICE_ISSUED>WITHDRAWN', 'LISTED>WITHDRAWN') THEN
    allowed := ARRAY['withdrawnReason', 'closedAt'];
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status', 'updatedAt'));
  IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A recovery''s figures, payment, notices and freeze dates are write-once: %s may change only %s', step, array_to_string(allowed, ', '));
  END IF;
  IF NEW."valuationNoticeIssuedOn" IS DISTINCT FROM OLD."valuationNoticeIssuedOn"
      AND NOT (OLD."status"='VALUED' AND NEW."status"='VALUATION_NOTICE_ISSUED')
      AND NOT (OLD."status"=NEW."status" AND OLD."status"::text IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','LISTED','SOLD','PROCEEDS_APPLIED') AND OLD."valuationNoticePath" IS NOT NULL
        AND OLD."valuationNoticeIssuedOn" IS NULL AND OLD."valuationNoticeReceivedOn" IS NULL
        AND NEW."valuationNoticeIssuedOn" IS NOT NULL AND NEW."valuationNoticeReceivedOn" IS NOT NULL
        AND length(btrim(COALESCE(NEW."valuationReceiptReference",'')))>=10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notice issue date is immutable except once with historical issue and receipt evidence';
  END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
      OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
      OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  -- The route rules of the matrix: NCA recoveries issue notices, NON_NCA ones do not.
  IF step IN ('VALUED>VALUATION_NOTICE_ISSUED', 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED') AND NOT nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an NCA recovery issues a valuation or final notice';
  END IF;
  IF step = 'VALUED>LISTED' AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery is listed only after its valuation notice';
  END IF;
  IF step IN ('PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD', 'PROCEEDS_APPLIED>CLOSED') AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery gives its final notice before the shortfall or surplus is opened';
  END IF;

  IF step = 'RECOVERED>VALUED' THEN
    IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is valued by a valuation of its own asset';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."valuationId" = NEW."valuationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery reuses its surrender''s valuation';
    END IF;
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    NEW."valuationNoticeIssuedOn" := today;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId"
          AND s."status" >= 'VALUATION_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s valuation notice';
      END IF;
    ELSIF NEW."valuationNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 valuation notice is stored with its digest';
    END IF;
  ELSIF step = 'LISTED>SOLD' THEN
    IF NOT EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is sold by a completed remarketing sale';
    END IF;
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    -- Charges freeze from the day the proceeds are applied: the caller does not choose the date.
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT s."priceInclVatCents", (s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO sale_price, sale_day
      FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED';
    IF NEW."settlementDueCents" IS NOT NULL AND NEW."grossProceedsCents" IS DISTINCT FROM sale_price THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The gross proceeds are the completed sale''s price';
    END IF;
    IF EXISTS (SELECT 1 FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'PENDING') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied once every cost is decided';
    END IF;
    -- only approved costs are deducted or charged; a rejected one is neither
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed"
          -- the receipt of this recovery's proceeds (its idempotency key), received on or after the day the sale completed
          AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'
          AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day;
      IF receipt_total IS DISTINCT FROM expected_receipt THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan';
      END IF;
    ELSIF NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No receipt is credited when the net proceeds or the settlement is nil';
    END IF;
    -- UNTESTED: the charge freeze (NCA s127(8); a NON_NCA demand period) is for the lender's legal team to sign off.
    IF nca THEN
      IF NEW."chargesFrozenUntil" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA freeze ends 10 business days after the final notice, set with it';
      END IF;
    ELSE
      SELECT c."nonNcaDemandPeriodDays" INTO config FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
      IF NEW."chargesFrozenUntil" IS DISTINCT FROM NEW."chargesFrozenFrom" + COALESCE(config."nonNcaDemandPeriodDays", 10) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA freeze runs the lender''s demand period from the proceeds';
      END IF;
    END IF;
  -- UNTESTED: s127(8) read as 10 SA business days after the final notice.
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    -- the notice states what is owed: not before the costs the ledger could not carry are known
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';
    END IF;
    IF NEW."finalNoticeIssuedOn" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final notice is dated from the proceeds to today';
    END IF;
    IF NEW."chargesFrozenUntil" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Charges stay frozen until 10 business days after the final notice';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'FINAL_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s final notice';
      END IF;
    ELSIF NEW."finalNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 final notice is stored with its digest';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SHORTFALL_OPEN') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before a shortfall is opened';
    END IF;
    -- what is still owed: the shortfall less the charged costs that could not go on the ledger
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
    -- the debtor's account is settled (the receipt paid it in full) before any surplus is held for refund
    IF loan_row.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held only once the loan is settled';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the recovery closes';
    END IF;
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus closes when its refund is released';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' THEN
    IF length(btrim(COALESCE(NEW."withdrawnReason", ''))) < 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A withdrawal records its reason (at least 10 characters)';
    END IF;
    IF EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery with a completed sale cannot be withdrawn';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardNcaSaleWindow"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE received DATE; nca BOOLEAN; today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_TABLE_NAME='SurrenderRequest' THEN
    IF NEW."status" NOT IN ('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN RETURN NEW; END IF;
    nca := true; received := NEW."valuationNoticeReceivedOn";
  ELSIF TG_TABLE_NAME='Recovery' THEN
    IF NEW."status" NOT IN ('LISTED','SOLD','PROCEEDS_APPLIED') THEN RETURN NEW; END IF;
    nca := NEW."route" IN ('NCA_S127_SURRENDER','NCA_S131_ATTACHMENT');
    received := NEW."valuationNoticeReceivedOn";
    IF NEW."surrenderRequestId" IS NOT NULL THEN
      SELECT s."valuationNoticeReceivedOn" INTO received FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderRequestId" FOR SHARE;
    END IF;
  ELSE
    IF NEW."status"='CANCELLED' THEN RETURN NEW; END IF;
    SELECT r."route" IN ('NCA_S127_SURRENDER','NCA_S131_ATTACHMENT'), COALESCE(s."valuationNoticeReceivedOn",r."valuationNoticeReceivedOn")
    INTO nca,received FROM "Recovery" r LEFT JOIN "SurrenderRequest" s ON s."id"=r."surrenderRequestId"
    WHERE r."id"=NEW."recoveryId" FOR SHARE OF r;
  END IF;
  IF nca AND (received IS NULL OR today <= public."recoveryAddBusinessDays"(received,10)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA sale waits until ten business days after valuation notice receipt';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Recovery_sale_window" BEFORE INSERT OR UPDATE ON "Recovery" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
CREATE TRIGGER "SurrenderRequest_sale_window" BEFORE INSERT OR UPDATE ON "SurrenderRequest" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
CREATE TRIGGER "RemarketingSale_nca_window" BEFORE INSERT OR UPDATE ON "RemarketingSale" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
COMMIT;
-- Receipt insert is gated too: a failed proceeds transition must never leave an applied orphan receipt.
CREATE OR REPLACE FUNCTION public."guardNcaSurrenderReceiptWindow"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE receipt_date DATE; received DATE;
BEGIN
 IF NEW."idempotencyKey" LIKE 'asset-surrender:%:proceeds' THEN
  SELECT "valuationNoticeReceivedOn" INTO received FROM "SurrenderRequest"
   WHERE "id"=split_part(NEW."idempotencyKey",':',2) AND "tenantId"=NEW."tenantId" AND "loanId"=NEW."loanId" FOR SHARE;
  receipt_date := (NEW."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date;
  IF received IS NULL OR receipt_date <= public."recoveryAddBusinessDays"(received,10) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surrender proceeds receipt waits for the valuation notice window';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "Payment_surrender_window" BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurrenderReceiptWindow"();
```

### prisma/migrations/20261017180200_nca_surplus_remittance/migration.sql

Existing functions changed: `guardRecovery`.

Exact proposed SQL:

```sql
-- CreateTable
CREATE TABLE "NcaSurplusAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "evidenceDocumentId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "releaseAuthorisedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NcaSurplusAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcaSurplusRemittance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "surrenderId" TEXT,
    "recoveryId" TEXT,
    "accountId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "exceptionReason" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "issuedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NcaSurplusRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusAccount_tenantId_id_key" ON "NcaSurplusAccount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusAccount_tenantId_loanId_key" ON "NcaSurplusAccount"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusRemittance_surrenderId_key" ON "NcaSurplusRemittance"("surrenderId");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusRemittance_recoveryId_key" ON "NcaSurplusRemittance"("recoveryId");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusRemittance_tenantId_id_key" ON "NcaSurplusRemittance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusRemittance_tenantId_surrenderId_key" ON "NcaSurplusRemittance"("tenantId", "surrenderId");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusRemittance_tenantId_recoveryId_key" ON "NcaSurplusRemittance"("tenantId", "recoveryId");

-- AddForeignKey
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_tenantId_surrenderId_fkey" FOREIGN KEY ("tenantId", "surrenderId") REFERENCES "SurrenderRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "NcaSurplusAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written legal enforcement (new objects only).
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_bank_check" CHECK (
 length(btrim("accountHolder")) >= 2 AND length(btrim("bankName")) >= 2 AND "branchCode" ~ '^[0-9]{6}$' AND "accountNumber" ~ '^[0-9]{6,16}$');
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_result_check" CHECK (
 num_nonnulls("surrenderId","recoveryId")=1 AND "amountCents">0 AND (
 ("status"='INSTRUCTED' AND "accountId" IS NOT NULL AND (("exceptionReason" IS NULL AND "releasedAt" IS NULL AND "releasedById" IS NULL) OR (length(btrim("exceptionReason"))>=10 AND "releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL))) OR
 ("status"='HELD_NO_VERIFIED_ACCOUNT' AND "accountId" IS NULL AND "releasedAt" IS NULL AND "releasedById" IS NULL AND length(btrim("exceptionReason"))>=10)));
CREATE OR REPLACE FUNCTION public."guardNcaSurplusAccount"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE borrower RECORD;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus bank verification is retained'; END IF;
 SELECT "clientId","entityId" INTO borrower FROM "Loan" WHERE "id"=NEW."loanId" AND "tenantId"=NEW."tenantId" AND "ncaRegime"='NCA' AND "contractType"<>'LOAN' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account needs the NCA borrower bank evidence'; END IF;
 PERFORM 1 FROM "EntityDocument" d WHERE d."id"=NEW."evidenceDocumentId" AND d."tenantId"=NEW."tenantId" FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d WHERE d."id"=NEW."evidenceDocumentId" AND d."tenantId"=NEW."tenantId"
   AND (d."clientId",d."entityId") IS NOT DISTINCT FROM (borrower."clientId",borrower."entityId")
   AND d."deletedAt" IS NULL AND d."fileSize">0 AND d."docType" IN ('BANK_STATEMENT','OTHER') AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."uploadedByType"='staff') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account needs the NCA borrower bank evidence';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."approvedById" IS NOT NULL OR NEW."releaseAuthorisedById" IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account opens without approval'; END IF;
 ELSE
  IF (to_jsonb(NEW)-'approvedById'-'releaseAuthorisedById') IS DISTINCT FROM (to_jsonb(OLD)-'approvedById'-'releaseAuthorisedById')
    OR OLD."releaseAuthorisedById" IS NOT NULL OR (OLD."approvedById" IS NOT NULL AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById") THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Verified surplus bank account evidence is immutable';
  END IF;
 END IF;
 IF NEW."approvedById" = NEW."createdById" OR NEW."releaseAuthorisedById" IN (NEW."createdById",NEW."approvedById")
   OR (NEW."releaseAuthorisedById" IS NOT NULL AND NEW."approvedById" IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus verification and release require separate staff';
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW."createdById",NEW."approvedById",NEW."releaseAuthorisedById"]) actor
  WHERE actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id"=actor AND u."tenantId"=NEW."tenantId")) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus approval staff belong to this lender';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "NcaSurplusAccount_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcaSurplusAccount" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurplusAccount"();
CREATE TRIGGER "NcaSurplusAccount_no_truncate" BEFORE TRUNCATE ON "NcaSurplusAccount" FOR EACH STATEMENT EXECUTE FUNCTION public."guardNcaSurplusAccount"();
CREATE OR REPLACE FUNCTION public."guardNcaSurplusRemittance"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE parent RECORD; account RECORD;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus payment instructions are immutable'; END IF;
  IF OLD."status"<>'HELD_NO_VERIFIED_ACCOUNT' OR NEW."status"<>'INSTRUCTED'
    OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."releasedById" IS NULL
    OR (to_jsonb(NEW)-ARRAY['status','accountId','releasedAt','releasedById']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','accountId','releasedAt','releasedById'])
    OR NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderId" AND s."tenantId"=NEW."tenantId" AND s."status"='FINAL_NOTICE_ISSUED' AND s."finalNoticePath" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Recovery" r WHERE r."surrenderRequestId"=s."id")) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only a held standalone surplus may issue once after bank authorisation';
  END IF;
  NEW."releasedAt" := now();
 ELSIF NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surplus release follows its recorded exception';
 END IF;
 IF NEW."surrenderId" IS NOT NULL THEN
  SELECT "loanId", "status"::TEXT AS status,"refundCents" AS surplus INTO parent FROM "SurrenderRequest" WHERE "id"=NEW."surrenderId" AND "tenantId"=NEW."tenantId" FOR SHARE;
 ELSE
  SELECT "loanId", "status"::TEXT AS status,"surplusCents" AS surplus INTO parent FROM "Recovery" WHERE "id"=NEW."recoveryId" AND "tenantId"=NEW."tenantId" AND "route"='NCA_S131_ATTACHMENT' FOR SHARE;
 END IF;
 IF NOT FOUND OR parent.status NOT IN ('PROCEEDS_CREDITED','PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED') OR NEW."amountCents" IS DISTINCT FROM parent.surplus THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction equals the notice surplus';
 END IF;
 SELECT * INTO account FROM "NcaSurplusAccount" WHERE "tenantId"=NEW."tenantId" AND "loanId"=parent."loanId" FOR SHARE;
 IF NEW."status"='INSTRUCTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId" AND l."status"='COMPLETED') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus is remitted only after the loan is settled';
  END IF;
  IF account."id" IS DISTINCT FROM NEW."accountId" OR account."approvedById" IS NULL OR account."releaseAuthorisedById" IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction requires verified bank and prior release authority';
  END IF;
 ELSIF account."approvedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A verified bank account cannot be reported unavailable';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "NcaSurplusRemittance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcaSurplusRemittance" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurplusRemittance"();
CREATE TRIGGER "NcaSurplusRemittance_no_truncate" BEFORE TRUNCATE ON "NcaSurplusRemittance" FOR EACH STATEMENT EXECUTE FUNCTION public."guardNcaSurplusRemittance"();
CREATE OR REPLACE FUNCTION public."requireNcaFinalNoticeRemittance"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE surplus INTEGER; covered BOOLEAN;
BEGIN
 IF NEW."status"::TEXT <> 'FINAL_NOTICE_ISSUED' OR OLD."status"::TEXT='FINAL_NOTICE_ISSUED' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='SurrenderRequest' THEN
  surplus:=NEW."refundCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."surrenderId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus) INTO covered;
 ELSE
  IF NEW."route"<>'NCA_S131_ATTACHMENT' THEN RETURN NULL; END IF;
  surplus:=NEW."surplusCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."recoveryId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus) INTO covered;
 END IF;
 IF surplus>0 AND NOT covered THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='NCA final notice and surplus payment instruction or bank exception issue together'; END IF;
 RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "SurrenderRequest_final_remittance" AFTER UPDATE ON "SurrenderRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."requireNcaFinalNoticeRemittance"();
CREATE CONSTRAINT TRIGGER "Recovery_final_remittance" AFTER UPDATE ON "Recovery" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."requireNcaFinalNoticeRemittance"();
ALTER TABLE "NcaSurplusAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NcaSurplusAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NcaSurplusAccount" USING (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant());
ALTER TABLE "NcaSurplusRemittance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NcaSurplusRemittance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NcaSurplusRemittance" USING (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant());
-- Protect the old refund path from issuing the same surplus a second time.
CREATE OR REPLACE FUNCTION public."guardNcaSurplusDuplicateRefund"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF EXISTS (SELECT 1 FROM "Recovery" c JOIN "NcaSurplusRemittance" r ON (r."recoveryId"=c."id" OR r."surrenderId"=c."surrenderRequestId")
   WHERE c."id"=NEW."recoveryId" AND c."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The NCA surplus already has its final-notice payment instruction';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "RecoveryRefund_no_duplicate_nca" BEFORE INSERT OR UPDATE ON "RecoveryRefund" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurplusDuplicateRefund"();
CREATE OR REPLACE FUNCTION public."guardNcaSurplusBankEvidence"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."evidenceDocumentId"=OLD."id")
   AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt')) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus bank evidence is retained unchanged';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "EntityDocument_surplus_evidence" BEFORE UPDATE OR DELETE ON "EntityDocument" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurplusBankEvidence"();

CREATE OR REPLACE FUNCTION public."guardRecovery"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  surrender RECORD;
  config RECORD;
  costs RECORD;
  nca BOOLEAN;
  step TEXT;
  allowed TEXT[];
  changed TEXT[];
  expected_receipt INTEGER;
  receipt_total INTEGER;
  sale_price INTEGER;
  sale_day DATE;
  live_status TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is never deleted';
  END IF;
  nca := NEW."route" IN ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT');
  SELECT l."ncaRegime"::TEXT AS regime, l."contractType"::TEXT AS contract_type, l."assetId", l."status"::TEXT AS status INTO loan_row
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row.contract_type = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery belongs to an asset-finance loan and its financed asset';
  END IF;
  IF nca <> (loan_row.regime = 'NCA') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The recovery route must match the loan''s NCA regime';
  END IF;
  IF NEW."meterReadingId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."meterReadingId" IS DISTINCT FROM OLD."meterReadingId") AND NOT EXISTS (
      SELECT 1 FROM "AssetMeterReading" r WHERE r."id" = NEW."meterReadingId" AND r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s meter reading is its own asset''s';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")>0 OR NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    -- Locks, in this order, on the rows the checks below read, so a concurrent booking, completion or credit cannot slip
    -- between the check and the commit (READ COMMITTED): the loan (FOR SHARE: its status cannot change under us), the
    -- asset (FOR UPDATE: it conflicts with the key-share lock a Loan insert takes through its foreign key, and with the
    -- Loan guard's share lock) and the surrender (FOR UPDATE: a credit of it waits, then sees this recovery).
    SELECT l."status"::TEXT INTO live_status FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;
    IF live_status NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened on an active, defaulted or pending write-off loan';
    END IF;
    -- the asset's lessor status before the recovery: none, or the stock a lease returned (a re-leased asset is recovered too)
    SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
    -- the loan that holds the asset now: an asset a lease returned and a new lease took is the new lease's
    IF EXISTS (SELECT 1 FROM "Loan" o WHERE o."tenantId" = NEW."tenantId" AND o."assetId" = NEW."assetId" AND o."id" <> NEW."loanId"
        AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'WRITTEN_OFF')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened by the loan that holds the asset now';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NEW."surrenderRequestId" IS NOT NULL THEN
      PERFORM 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows a surrender that has not yet been credited or finally noticed';
      END IF;
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."status" <> 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery stands on an open legal matter';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA court-order recovery needs the legal matter''s judgment';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CLOSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed or withdrawn recovery is final';
  END IF;
  -- The columns this step may write. Everything else is fixed: the loan, asset, route, surrender,
  -- legal matter, date and creator from the start, and the valuation, notices, figures, payment and
  -- freeze dates once written, because each is written by exactly one step.
  step := OLD."status"::TEXT || '>' || NEW."status"::TEXT;
  IF OLD."status" = NEW."status" THEN
    allowed := ARRAY['location', 'condition', 'meterReadingId', 'valuationNoticeIssuedOn', 'valuationNoticeReceivedOn', 'valuationReceiptReference'];
    -- once the proceeds are applied, the costs the ledger could not carry are recorded: NULL to a value, in this status only
    IF OLD."status" = 'PROCEEDS_APPLIED' AND OLD."unrecoverableCostsCents" IS NULL THEN
      allowed := allowed || ARRAY['unrecoverableCostsCents'];
    END IF;
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256', 'valuationNoticeIssuedOn'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil', 'unrecoverableCostsCents'];
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    allowed := ARRAY['finalNoticeIssuedOn', 'finalNoticePath', 'finalNoticeSha256', 'chargesFrozenUntil'];
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED', 'SHORTFALL_OPEN>CLOSED', 'SURPLUS_HELD>CLOSED') THEN
    allowed := ARRAY['closedAt'];
  ELSIF step IN ('RECOVERED>WITHDRAWN', 'VALUED>WITHDRAWN', 'VALUATION_NOTICE_ISSUED>WITHDRAWN', 'LISTED>WITHDRAWN') THEN
    allowed := ARRAY['withdrawnReason', 'closedAt'];
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status', 'updatedAt'));
  IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A recovery''s figures, payment, notices and freeze dates are write-once: %s may change only %s', step, array_to_string(allowed, ', '));
  END IF;
  IF NEW."valuationNoticeIssuedOn" IS DISTINCT FROM OLD."valuationNoticeIssuedOn"
      AND NOT (OLD."status"='VALUED' AND NEW."status"='VALUATION_NOTICE_ISSUED')
      AND NOT (OLD."status"=NEW."status" AND OLD."status"::text IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','LISTED','SOLD','PROCEEDS_APPLIED') AND OLD."valuationNoticePath" IS NOT NULL
        AND OLD."valuationNoticeIssuedOn" IS NULL AND OLD."valuationNoticeReceivedOn" IS NULL
        AND NEW."valuationNoticeIssuedOn" IS NOT NULL AND NEW."valuationNoticeReceivedOn" IS NOT NULL
        AND length(btrim(COALESCE(NEW."valuationReceiptReference",'')))>=10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notice issue date is immutable except once with historical issue and receipt evidence';
  END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
      OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
      OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  -- The route rules of the matrix: NCA recoveries issue notices, NON_NCA ones do not.
  IF step IN ('VALUED>VALUATION_NOTICE_ISSUED', 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED') AND NOT nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an NCA recovery issues a valuation or final notice';
  END IF;
  IF step = 'VALUED>LISTED' AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery is listed only after its valuation notice';
  END IF;
  IF step IN ('PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD', 'PROCEEDS_APPLIED>CLOSED') AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery gives its final notice before the shortfall or surplus is opened';
  END IF;

  IF step = 'RECOVERED>VALUED' THEN
    IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is valued by a valuation of its own asset';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."valuationId" = NEW."valuationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery reuses its surrender''s valuation';
    END IF;
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    NEW."valuationNoticeIssuedOn" := today;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId"
          AND s."status" >= 'VALUATION_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s valuation notice';
      END IF;
    ELSIF NEW."valuationNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 valuation notice is stored with its digest';
    END IF;
  ELSIF step = 'LISTED>SOLD' THEN
    IF NOT EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is sold by a completed remarketing sale';
    END IF;
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    -- Charges freeze from the day the proceeds are applied: the caller does not choose the date.
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT s."priceInclVatCents", (s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO sale_price, sale_day
      FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED';
    IF NEW."settlementDueCents" IS NOT NULL AND NEW."grossProceedsCents" IS DISTINCT FROM sale_price THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The gross proceeds are the completed sale''s price';
    END IF;
    IF EXISTS (SELECT 1 FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'PENDING') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied once every cost is decided';
    END IF;
    -- only approved costs are deducted or charged; a rejected one is neither
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed"
          -- the receipt of this recovery's proceeds (its idempotency key), received on or after the day the sale completed
          AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'
          AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day;
      IF receipt_total IS DISTINCT FROM expected_receipt THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan';
      END IF;
    ELSIF NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No receipt is credited when the net proceeds or the settlement is nil';
    END IF;
    -- UNTESTED: the charge freeze (NCA s127(8); a NON_NCA demand period) is for the lender's legal team to sign off.
    IF nca THEN
      IF NEW."chargesFrozenUntil" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA freeze ends 10 business days after the final notice, set with it';
      END IF;
    ELSE
      SELECT c."nonNcaDemandPeriodDays" INTO config FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
      IF NEW."chargesFrozenUntil" IS DISTINCT FROM NEW."chargesFrozenFrom" + COALESCE(config."nonNcaDemandPeriodDays", 10) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA freeze runs the lender''s demand period from the proceeds';
      END IF;
    END IF;
  -- UNTESTED: s127(8) read as 10 SA business days after the final notice.
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    -- the notice states what is owed: not before the costs the ledger could not carry are known
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';
    END IF;
    IF NEW."finalNoticeIssuedOn" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final notice is dated from the proceeds to today';
    END IF;
    IF NEW."chargesFrozenUntil" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Charges stay frozen until 10 business days after the final notice';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'FINAL_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s final notice';
      END IF;
    ELSIF NEW."finalNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 final notice is stored with its digest';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SHORTFALL_OPEN') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before a shortfall is opened';
    END IF;
    -- what is still owed: the shortfall less the charged costs that could not go on the ledger
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
    -- the debtor's account is settled (the receipt paid it in full) before any surplus is held for refund
    IF loan_row.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held only once the loan is settled';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the recovery closes';
    END IF;
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN
      IF NOT (NEW."shortfallCents" - NEW."unrecoverableCostsCents" = 0 AND EXISTS (
        SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED'
        AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
      END IF;
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus closes when its refund is released';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' THEN
    IF length(btrim(COALESCE(NEW."withdrawnReason", ''))) < 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A withdrawal records its reason (at least 10 characters)';
    END IF;
    IF EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery with a completed sale cannot be withdrawn';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_createdById_fkey" FOREIGN KEY ("tenantId","createdById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId","approvedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_tenantId_releaseAuthorisedById_fkey" FOREIGN KEY ("tenantId","releaseAuthorisedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_tenantId_issuedById_fkey" FOREIGN KEY ("tenantId","issuedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_releasedBy_fkey" FOREIGN KEY ("tenantId","releasedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
```

### prisma/migrations/20261017180300_nca_surplus_execution/migration.sql

Existing functions changed: `guardRecovery`.

Exact proposed SQL:

```sql
-- An instruction does not prove bank execution. Retain evidence before closing surplus liability.
ALTER TABLE "NcaSurplusRemittance" ADD COLUMN "executedOn" DATE, ADD COLUMN "bankExecutionReference" TEXT,
 ADD COLUMN "executionEvidenceDocumentId" TEXT, ADD COLUMN "executedById" TEXT, ADD COLUMN "executionRecordedAt" TIMESTAMP(3);
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_execution_all_or_none" CHECK (
 ("executedOn" IS NULL AND "bankExecutionReference" IS NULL AND "executionEvidenceDocumentId" IS NULL AND "executedById" IS NULL AND "executionRecordedAt" IS NULL)
 OR ("status"='INSTRUCTED' AND "executedOn" IS NOT NULL AND "bankExecutionReference" IS NOT NULL AND "executionEvidenceDocumentId" IS NOT NULL AND "executedById" IS NOT NULL AND "executionRecordedAt" IS NOT NULL));
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_execution_document_fkey" FOREIGN KEY ("tenantId","executionEvidenceDocumentId") REFERENCES "EntityDocument"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_executed_by_fkey" FOREIGN KEY ("tenantId","executedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION public."guardNcaSurplusRemittance"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE parent RECORD; account RECORD;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus payment instructions are immutable'; END IF;
  IF OLD."status"='INSTRUCTED' AND NEW."status"='INSTRUCTED' THEN
   IF OLD."executedOn" IS NOT NULL OR NEW."executedOn" IS NULL OR NEW."executedById" IS NULL OR NEW."executionEvidenceDocumentId" IS NULL
     OR NEW."executionRecordedAt" IS NULL OR length(btrim(COALESCE(NEW."bankExecutionReference",''))) NOT BETWEEN 6 AND 200
     OR (to_jsonb(NEW)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution evidence is recorded once without changing its instruction';
   END IF;
   NEW."executionRecordedAt":=now();
  ELSIF OLD."status"<>'HELD_NO_VERIFIED_ACCOUNT'  OR NEW."status"<>'INSTRUCTED'
    OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."releasedById" IS NULL
    OR (to_jsonb(NEW)-ARRAY['status','accountId','releasedAt','releasedById']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','accountId','releasedAt','releasedById'])
    OR NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderId" AND s."tenantId"=NEW."tenantId" AND s."status"='FINAL_NOTICE_ISSUED' AND s."finalNoticePath" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Recovery" r WHERE r."surrenderRequestId"=s."id")) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only a held standalone surplus may issue once after bank authorisation';
  END IF;
  IF OLD."status"='HELD_NO_VERIFIED_ACCOUNT' THEN NEW."releasedAt" := now(); END IF;
 ELSIF NEW."executedOn" IS NOT NULL OR NEW."bankExecutionReference" IS NOT NULL OR NEW."executionEvidenceDocumentId" IS NOT NULL OR NEW."executedById" IS NOT NULL OR NEW."executionRecordedAt" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution follows an existing instruction and final notice';
 ELSIF NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surplus release follows its recorded exception';
 END IF;
 IF NEW."surrenderId" IS NOT NULL THEN
  SELECT "loanId", "status"::TEXT AS status,"refundCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "SurrenderRequest" WHERE "id"=NEW."surrenderId" AND "tenantId"=NEW."tenantId" FOR SHARE;
 ELSE
  SELECT "loanId", "status"::TEXT AS status,"surplusCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "Recovery" WHERE "id"=NEW."recoveryId" AND "tenantId"=NEW."tenantId" AND "route"='NCA_S131_ATTACHMENT' FOR SHARE;
 END IF;
 IF NOT FOUND OR parent.status NOT IN ('PROCEEDS_CREDITED','PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED') OR NEW."amountCents" IS DISTINCT FROM parent.surplus THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction equals the notice surplus';
 END IF;
 SELECT * INTO account FROM "NcaSurplusAccount" WHERE "tenantId"=NEW."tenantId" AND "loanId"=parent."loanId" FOR SHARE;
 IF NEW."status"='INSTRUCTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId" AND l."status"='COMPLETED') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus is remitted only after the loan is settled';
  END IF;
  IF account."id" IS DISTINCT FROM NEW."accountId" OR account."approvedById" IS NULL OR account."releaseAuthorisedById" IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction requires verified bank and prior release authority';
  END IF;
 ELSIF account."approvedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A verified bank account cannot be reported unavailable';
 END IF;
 IF NEW."executedOn" IS NOT NULL THEN
  IF parent.status<>'FINAL_NOTICE_ISSUED' OR parent.notice_path IS NULL OR NEW."executedOn" < (COALESCE(OLD."releasedAt",OLD."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date OR NEW."executedOn">(now() AT TIME ZONE 'Africa/Johannesburg')::date
    OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d JOIN "Loan" l ON l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId"
      WHERE d."id"=NEW."executionEvidenceDocumentId" AND d."tenantId"=NEW."tenantId" AND d."deletedAt" IS NULL
        AND d."clientId" IS NOT DISTINCT FROM l."clientId" AND d."entityId" IS NOT DISTINCT FROM l."entityId"
        AND d."docType" IN ('BANK_STATEMENT','OTHER') AND d."uploadedByType"='staff' AND d."uploadedById"=NEW."executedById"
        AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."fileSize">0) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Execution needs final notice, valid bank date and retained borrower-owned staff bank evidence';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRecovery"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  surrender RECORD;
  config RECORD;
  costs RECORD;
  nca BOOLEAN;
  step TEXT;
  allowed TEXT[];
  changed TEXT[];
  expected_receipt INTEGER;
  receipt_total INTEGER;
  sale_price INTEGER;
  sale_day DATE;
  live_status TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is never deleted';
  END IF;
  nca := NEW."route" IN ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT');
  SELECT l."ncaRegime"::TEXT AS regime, l."contractType"::TEXT AS contract_type, l."assetId", l."status"::TEXT AS status INTO loan_row
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row.contract_type = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery belongs to an asset-finance loan and its financed asset';
  END IF;
  IF nca <> (loan_row.regime = 'NCA') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The recovery route must match the loan''s NCA regime';
  END IF;
  IF NEW."meterReadingId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."meterReadingId" IS DISTINCT FROM OLD."meterReadingId") AND NOT EXISTS (
      SELECT 1 FROM "AssetMeterReading" r WHERE r."id" = NEW."meterReadingId" AND r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s meter reading is its own asset''s';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")>0 OR NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    -- Locks, in this order, on the rows the checks below read, so a concurrent booking, completion or credit cannot slip
    -- between the check and the commit (READ COMMITTED): the loan (FOR SHARE: its status cannot change under us), the
    -- asset (FOR UPDATE: it conflicts with the key-share lock a Loan insert takes through its foreign key, and with the
    -- Loan guard's share lock) and the surrender (FOR UPDATE: a credit of it waits, then sees this recovery).
    SELECT l."status"::TEXT INTO live_status FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;
    IF live_status NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened on an active, defaulted or pending write-off loan';
    END IF;
    -- the asset's lessor status before the recovery: none, or the stock a lease returned (a re-leased asset is recovered too)
    SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
    -- the loan that holds the asset now: an asset a lease returned and a new lease took is the new lease's
    IF EXISTS (SELECT 1 FROM "Loan" o WHERE o."tenantId" = NEW."tenantId" AND o."assetId" = NEW."assetId" AND o."id" <> NEW."loanId"
        AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'WRITTEN_OFF')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened by the loan that holds the asset now';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NEW."surrenderRequestId" IS NOT NULL THEN
      PERFORM 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows a surrender that has not yet been credited or finally noticed';
      END IF;
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."status" <> 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery stands on an open legal matter';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA court-order recovery needs the legal matter''s judgment';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CLOSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed or withdrawn recovery is final';
  END IF;
  -- The columns this step may write. Everything else is fixed: the loan, asset, route, surrender,
  -- legal matter, date and creator from the start, and the valuation, notices, figures, payment and
  -- freeze dates once written, because each is written by exactly one step.
  step := OLD."status"::TEXT || '>' || NEW."status"::TEXT;
  IF OLD."status" = NEW."status" THEN
    allowed := ARRAY['location', 'condition', 'meterReadingId', 'valuationNoticeIssuedOn', 'valuationNoticeReceivedOn', 'valuationReceiptReference'];
    -- once the proceeds are applied, the costs the ledger could not carry are recorded: NULL to a value, in this status only
    IF OLD."status" = 'PROCEEDS_APPLIED' AND OLD."unrecoverableCostsCents" IS NULL THEN
      allowed := allowed || ARRAY['unrecoverableCostsCents'];
    END IF;
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256', 'valuationNoticeIssuedOn'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil', 'unrecoverableCostsCents'];
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    allowed := ARRAY['finalNoticeIssuedOn', 'finalNoticePath', 'finalNoticeSha256', 'chargesFrozenUntil'];
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED', 'SHORTFALL_OPEN>CLOSED', 'SURPLUS_HELD>CLOSED') THEN
    allowed := ARRAY['closedAt'];
  ELSIF step IN ('RECOVERED>WITHDRAWN', 'VALUED>WITHDRAWN', 'VALUATION_NOTICE_ISSUED>WITHDRAWN', 'LISTED>WITHDRAWN') THEN
    allowed := ARRAY['withdrawnReason', 'closedAt'];
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status', 'updatedAt'));
  IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A recovery''s figures, payment, notices and freeze dates are write-once: %s may change only %s', step, array_to_string(allowed, ', '));
  END IF;
  IF NEW."valuationNoticeIssuedOn" IS DISTINCT FROM OLD."valuationNoticeIssuedOn"
      AND NOT (OLD."status"='VALUED' AND NEW."status"='VALUATION_NOTICE_ISSUED')
      AND NOT (OLD."status"=NEW."status" AND OLD."status"::text IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','LISTED','SOLD','PROCEEDS_APPLIED') AND OLD."valuationNoticePath" IS NOT NULL
        AND OLD."valuationNoticeIssuedOn" IS NULL AND OLD."valuationNoticeReceivedOn" IS NULL
        AND NEW."valuationNoticeIssuedOn" IS NOT NULL AND NEW."valuationNoticeReceivedOn" IS NOT NULL
        AND length(btrim(COALESCE(NEW."valuationReceiptReference",'')))>=10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notice issue date is immutable except once with historical issue and receipt evidence';
  END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
      OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
      OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  -- The route rules of the matrix: NCA recoveries issue notices, NON_NCA ones do not.
  IF step IN ('VALUED>VALUATION_NOTICE_ISSUED', 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED') AND NOT nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an NCA recovery issues a valuation or final notice';
  END IF;
  IF step = 'VALUED>LISTED' AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery is listed only after its valuation notice';
  END IF;
  IF step IN ('PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD', 'PROCEEDS_APPLIED>CLOSED') AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery gives its final notice before the shortfall or surplus is opened';
  END IF;

  IF step = 'RECOVERED>VALUED' THEN
    IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is valued by a valuation of its own asset';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."valuationId" = NEW."valuationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery reuses its surrender''s valuation';
    END IF;
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    NEW."valuationNoticeIssuedOn" := today;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId"
          AND s."status" >= 'VALUATION_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s valuation notice';
      END IF;
    ELSIF NEW."valuationNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 valuation notice is stored with its digest';
    END IF;
  ELSIF step = 'LISTED>SOLD' THEN
    IF NOT EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is sold by a completed remarketing sale';
    END IF;
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    -- Charges freeze from the day the proceeds are applied: the caller does not choose the date.
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT s."priceInclVatCents", (s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO sale_price, sale_day
      FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED';
    IF NEW."settlementDueCents" IS NOT NULL AND NEW."grossProceedsCents" IS DISTINCT FROM sale_price THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The gross proceeds are the completed sale''s price';
    END IF;
    IF EXISTS (SELECT 1 FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'PENDING') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied once every cost is decided';
    END IF;
    -- only approved costs are deducted or charged; a rejected one is neither
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed"
          -- the receipt of this recovery's proceeds (its idempotency key), received on or after the day the sale completed
          AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'
          AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day;
      IF receipt_total IS DISTINCT FROM expected_receipt THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan';
      END IF;
    ELSIF NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No receipt is credited when the net proceeds or the settlement is nil';
    END IF;
    -- UNTESTED: the charge freeze (NCA s127(8); a NON_NCA demand period) is for the lender's legal team to sign off.
    IF nca THEN
      IF NEW."chargesFrozenUntil" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA freeze ends 10 business days after the final notice, set with it';
      END IF;
    ELSE
      SELECT c."nonNcaDemandPeriodDays" INTO config FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
      IF NEW."chargesFrozenUntil" IS DISTINCT FROM NEW."chargesFrozenFrom" + COALESCE(config."nonNcaDemandPeriodDays", 10) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA freeze runs the lender''s demand period from the proceeds';
      END IF;
    END IF;
  -- UNTESTED: s127(8) read as 10 SA business days after the final notice.
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    -- the notice states what is owed: not before the costs the ledger could not carry are known
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';
    END IF;
    IF NEW."finalNoticeIssuedOn" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final notice is dated from the proceeds to today';
    END IF;
    IF NEW."chargesFrozenUntil" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Charges stay frozen until 10 business days after the final notice';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'FINAL_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s final notice';
      END IF;
    ELSIF NEW."finalNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 final notice is stored with its digest';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SHORTFALL_OPEN') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before a shortfall is opened';
    END IF;
    -- what is still owed: the shortfall less the charged costs that could not go on the ledger
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
    -- the debtor's account is settled (the receipt paid it in full) before any surplus is held for refund
    IF loan_row.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held only once the loan is settled';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the recovery closes';
    END IF;
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN
      IF NOT (NEW."shortfallCents" - NEW."unrecoverableCostsCents" = 0 AND EXISTS (
        SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED' AND r."executedOn" IS NOT NULL
        AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
      END IF;
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') AND NOT EXISTS (
      SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED' AND r."executedOn" IS NOT NULL
      AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus closes when its refund is released';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' THEN
    IF length(btrim(COALESCE(NEW."withdrawnReason", ''))) < 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A withdrawal records its reason (at least 10 characters)';
    END IF;
    IF EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery with a completed sale cannot be withdrawn';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardNcaSurplusBankEvidence"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF (EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."evidenceDocumentId"=OLD."id") OR EXISTS (SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."executionEvidenceDocumentId"=OLD."id"))
   AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt')) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus bank evidence is retained unchanged';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$function$;
```


## LEASE — source checkpoint 2c1138f8

### prisma/migrations/20261017110000_lease_legal_rules/migration.sql

Existing functions changed: `guardLeaseTerminationQuote`, `guardLeaseRental`, `checkLeaseRentalCancelled`, `guardLeaseEndOfTerm`, `guardMaintenanceFundMovement`.

Exact proposed SQL:

```sql
-- CPA s14 cancellation and continuation; VAT Act s67; actual lease loss.
ALTER TABLE "LeaseRental" ADD COLUMN "cancellationCreditNoteId" TEXT;
CREATE UNIQUE INDEX "CreditNote_tenantId_id_key" ON "CreditNote"("tenantId", "id");
CREATE UNIQUE INDEX "LeaseRental_cancellationCreditNoteId_key" ON "LeaseRental"("cancellationCreditNoteId");
CREATE UNIQUE INDEX "LeaseRental_tenantId_cancellationCreditNoteId_key" ON "LeaseRental"("tenantId", "cancellationCreditNoteId");
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_cancellationCreditNoteId_fkey" FOREIGN KEY ("tenantId", "cancellationCreditNoteId") REFERENCES "CreditNote"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LeaseEndOfTerm" ADD COLUMN "extensionNoticeByClientId" TEXT;
ALTER TABLE "LeaseTerminationQuote"
 ADD COLUMN "goodsValueCents" INTEGER,
 ADD COLUMN "documentedCosts" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "lessorCancellation" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "totalLoss" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "insuranceProceedsCents" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "lossEvidence" TEXT;
ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_amounts";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_amounts" CHECK (
 "pvCents" >= 0 AND "penaltyCents" >= 0 AND "arrearsCents" >= 0 AND "invoiceVatCents" >= 0 AND "remainingRentals" >= 0
 AND "invoiceExclVatCents" >= 0 AND "insuranceProceedsCents" >= 0
 AND ("goodsValueCents" IS NULL OR "goodsValueCents" >= 0)
 AND jsonb_typeof("documentedCosts") = 'array'
 AND ((NOT "cpaCancellation" AND NOT "totalLoss" AND "invoiceExclVatCents" = "pvCents" + "penaltyCents")
   OR (("cpaCancellation" OR "totalLoss") AND "penaltyCents" = 0))
 AND "totalCents" = "invoiceExclVatCents" + "invoiceVatCents" + "arrearsCents"
 AND "validUntil" >= "quotedOn" AND ("lessorCancellation" OR "terminationDate" >= "quotedOn")
 AND length(btrim("basis")) >= 10
 AND ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
 AND ("status" = 'ACCEPTED' OR ("taxInvoiceId" IS NULL AND "scheduleId" IS NULL))
 AND (NOT "totalLoss" OR length(btrim("lossEvidence")) > 0)
);
CREATE OR REPLACE FUNCTION public."guardLeaseTerminationQuote"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUOTED' OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
        AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND (l."status" IN ('ACTIVE', 'DEFAULTED') OR (l."status" = 'COMPLETED' AND public."leaseTermEnd"(l."id", l."tenantId") > today))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is written QUOTED for a running lease';
    END IF;
    IF NEW."quotedOn" <> today OR NEW."validUntil" > today + COALESCE((SELECT c."leaseTerminationQuoteValidDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is dated today and valid for the tenant''s days at most';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACCEPTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An accepted termination quote is final';
  END IF;
  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."quotedOn" IS DISTINCT FROM OLD."quotedOn" OR NEW."cpaCancellation" IS DISTINCT FROM OLD."cpaCancellation"
    OR NEW."lessorCancellation" IS DISTINCT FROM OLD."lessorCancellation" OR NEW."totalLoss" IS DISTINCT FROM OLD."totalLoss" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."requestedByClientId" IS DISTINCT FROM OLD."requestedByClientId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Termination identity and notice are immutable';
  END IF;
  IF NEW."status" <> 'ACCEPTED' AND (to_jsonb(NEW) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote''s figures are fixed when quoted';
  END IF;
  IF OLD."status" = 'QUOTED' AND NEW."status" = 'ACCEPTED' AND NOT NEW."cpaCancellation" AND NOT NEW."totalLoss" AND today > NEW."validUntil" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('The quote expired on %s', NEW."validUntil");
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardLeaseRental"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_type TEXT;
  invoice_row RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l."contractType"::TEXT INTO loan_type FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_type IS NULL OR loan_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental belongs to an operating or full-maintenance lease loan';
    END IF;
    IF loan_type = 'OPERATING_LEASE' AND NEW."maintenanceExclVatCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An operating lease rental carries no maintenance';
    END IF;
    IF NEW."taxInvoiceId" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is written uninvoiced';
    END IF;
    -- Only booking writes rentals: its deal is not BOOKED yet (it becomes
    -- BOOKED later in the same transaction; guardLeaseDealBooking).
    -- After booking, only a month-to-month extension's next rental: the next
    -- period, one month after the last, at the last rental and maintenance
    -- (lib/asset-finance/lease-charges.ts appendExtensionRental).
    IF EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."loanId" = NEW."loanId" AND d."tenantId" = NEW."tenantId" AND d."status" = 'BOOKED')
      AND NOT EXISTS (
        SELECT 1 FROM "LeaseEndOfTerm" e
        JOIN LATERAL (SELECT r.* FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" ORDER BY r."periodNo" DESC LIMIT 1) last ON TRUE
        WHERE e."loanId" = NEW."loanId" AND e."tenantId" = NEW."tenantId" AND e."status" = 'EXTENDING'
          -- In advance a rental due on the end date pays for the month after it: only rentals due before the end.
          AND (e."extensionEndsOn" IS NULL OR NEW."dueDate" < e."extensionEndsOn"
            OR (NEW."dueDate" = e."extensionEndsOn" AND NOT EXISTS (SELECT 1 FROM "AssetFinanceDeal" d
              WHERE d."loanId" = NEW."loanId" AND d."tenantId" = NEW."tenantId" AND d."rentalTiming" = 'ADVANCE')))
          AND NEW."periodNo" = last."periodNo" + 1
          AND NEW."dueDate" = (last."dueDate" + INTERVAL '1 month')::date
          AND NEW."rentalExclVatCents" = last."rentalExclVatCents" AND NEW."maintenanceExclVatCents" = last."maintenanceExclVatCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s rentals are written when it is booked, or one at a time on a month-to-month extension';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId"
    OR NEW."periodNo" IS DISTINCT FROM OLD."periodNo" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s period, loan, schedule row and due date are fixed';
  END IF;
  IF OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is set once';
  END IF;
  IF NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" AND (
    OLD."cancelledAt" IS NOT NULL
    OR ((OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL) AND NOT EXISTS (
      SELECT 1 FROM "CreditNote" c JOIN "TaxInvoice" i ON i."id" = c."invoiceId" AND i."tenantId" = c."tenantId"
      WHERE c."id" = NEW."cancellationCreditNoteId" AND c."tenantId" = NEW."tenantId" AND c."invoiceId" = OLD."taxInvoiceId"
        AND (SELECT SUM(n."inclVatCents") FROM "CreditNote" n WHERE n."invoiceId" = i."id" AND n."tenantId" = i."tenantId") = i."totalInclVatCents"))
    OR current_setting('credaflow.lease_terminate', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
      AND q."status" = 'QUOTED' AND NEW."dueDate" > q."terminationDate"
      AND (q."cpaCancellation" OR q."totalLoss" OR q."validUntil" >= (now() AT TIME ZONE 'Africa/Johannesburg')::date))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is cancelled once, uninvoiced, only by an accepted early termination';
  END IF;
  IF NEW."cancellationCreditNoteId" IS DISTINCT FROM OLD."cancellationCreditNoteId" AND (OLD."cancellationCreditNoteId" IS NOT NULL OR NEW."cancelledAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancellation credit note is set once with the rental cancellation';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancelled lease rental is never invoiced';
  END IF;
  IF NEW."rentalExclVatCents" IS DISTINCT FROM OLD."rentalExclVatCents"
    OR NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents"
    OR NEW."vatCents" IS DISTINCT FROM OLD."vatCents"
    OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents"
    OR NEW."vatRate" IS DISTINCT FROM OLD."vatRate" THEN
    IF current_setting('credaflow.lease_vat_supply', true) = 'on' THEN
      IF OLD."taxInvoiceId" IS NOT NULL OR OLD."cancelledAt" IS NOT NULL
        OR NEW."rentalExclVatCents" <> OLD."rentalExclVatCents" OR NEW."maintenanceExclVatCents" <> OLD."maintenanceExclVatCents"
        OR NOT EXISTS (SELECT 1 FROM "TaxInvoice" i
          WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId" AND i."loanId" = NEW."loanId"
            AND i."vatRate" = NEW."vatRate" AND i."totalInclVatCents" = NEW."totalCents") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Supply-date VAT repricing requires its invoice and unchanged net rental';
      END IF;
    ELSE
    IF OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL OR OLD."cancelledAt" IS NOT NULL
      OR current_setting('credaflow.lease_reprice', true) IS DISTINCT FROM 'on'
      OR NOT EXISTS (
        SELECT 1 FROM "ContractRate" c WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId"
          AND c."xmin" = pg_current_xact_id()::xid AND c."basis" <> 'FIXED' AND NEW."dueDate" >= c."effectiveDate"
          AND c."resultingRate" IS DISTINCT FROM (SELECT p."resultingRate" FROM "ContractRate" p WHERE p."loanId" = c."loanId"
            AND p."effectiveDate" < c."effectiveDate" ORDER BY p."effectiveDate" DESC LIMIT 1)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental''s amounts are fixed at booking; only a repricing changes them, before the rental is invoiced';
    END IF;
    IF NEW."vatRate" IS DISTINCT FROM OLD."vatRate"
      OR NEW."vatCents" <> "vatHalfUpCents"(NEW."rentalExclVatCents", NEW."vatRate") + "vatHalfUpCents"(NEW."maintenanceExclVatCents", NEW."vatRate") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repriced rental keeps its booked VAT rate, its VAT recomputed on it';
    END IF;
    IF NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repricing changes the rental, never the maintenance';
    END IF;
    END IF;
  END IF;
  IF OLD."taxInvoiceId" IS NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    SELECT i."loanId", i."totalInclVatCents", i."supplyDate" INTO invoice_row FROM "TaxInvoice" i
      WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId";
    IF invoice_row."loanId" IS DISTINCT FROM NEW."loanId" OR invoice_row."totalInclVatCents" IS DISTINCT FROM NEW."totalCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is of its loan, for the rental''s total';
    END IF;
    -- Time of supply: the earlier of the due date and a payment towards the
    -- rental. Receipts settle the oldest rows first, so a payment has reached
    -- this rental only once the cash received by the supply date (allocated,
    -- unreversed, not a waiver, net of default charges)
    -- exceeds everything due on the earlier rows.
    IF invoice_row."supplyDate" > NEW."dueDate" OR (invoice_row."supplyDate" < NEW."dueDate" AND (NOT EXISTS (
        SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = NEW."scheduleId" AND s."tenantId" = NEW."tenantId" AND s."totalPaid" > 0)
      OR (SELECT COALESCE(SUM(p."amount" - p."defaultInterestAllocated" - p."chargeFeesAllocated"), 0) FROM "Payment" p
          WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId" AND p."reversed" = false
            AND p."allocationStatus" = 'ALLOCATED' AND p."paymentMethod"::TEXT <> 'WAIVER'
            AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= invoice_row."supplyDate")
        <= (SELECT COALESCE(SUM(s."totalDue"), 0) FROM "RepaymentSchedule" s
          WHERE s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId" AND s."installmentNo" < NEW."periodNo"))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental is supplied on its due date, or earlier only once a payment has reached it';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."checkLeaseRentalCancelled"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."cancelledAt" IS NOT NULL AND OLD."cancelledAt" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss") AND q."xmin" = pg_current_xact_id()::xid AND NEW."dueDate" > q."terminationDate") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rental is cancelled only by a termination accepted with it';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  returns_on DATE;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL
       OR NEW."inspectedOn" IS NOT NULL OR NEW."extensionNoticeOn" IS NOT NULL OR NEW."extensionEndsOn" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
    -- The elector changes only with a re-based purchase (the re-baser elects); purchase terms only while ELECTED.
    OR ((NEW."electedById" IS DISTINCT FROM OLD."electedById" OR NEW."electedByClientId" IS DISTINCT FROM OLD."electedByClientId")
      AND NOT (OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' AND NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."status" <> 'ELECTED' AND (NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents"
      OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
    OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
    OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
      OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition" OR NEW."inspectedById" IS DISTINCT FROM OLD."inspectedById"))
    OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn")
    OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn"
      AND NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND q."status" = 'ACCEPTED' AND q."lessorCancellation" AND q."terminationDate" = NEW."extensionEndsOn"))
    OR (OLD."natisTransferConfirmedAt" IS NOT NULL AND NEW."natisTransferConfirmedAt" IS DISTINCT FROM OLD."natisTransferConfirmedAt")
    OR (OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents" IS DISTINCT FROM OLD."excessUsageCents"
      OR NEW."fundSettlementCents" IS DISTINCT FROM OLD."fundSettlementCents")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
  END IF;
  -- An elected purchase is re-based only when its valuation has aged out: by staff (who become the
  -- elector), onto another valuation, at that valuation's amount, under the same rule as the election.
  IF NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId" THEN
    IF NEW."purchaseValuationId" IS NOT DISTINCT FROM OLD."purchaseValuationId" OR NEW."electedById" IS NULL OR NEW."electedByClientId" IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM "AssetValuation" o JOIN "AssetValuation" n ON n."id" = NEW."purchaseValuationId" AND n."tenantId" = o."tenantId"
         WHERE o."id" = OLD."purchaseValuationId" AND o."tenantId" = NEW."tenantId" AND o."valuedOn" < today - max_age
           AND NEW."purchasePriceExclVatCents" = n."amountCents"
           -- the house rule's valuation: no current market valuation of the asset is higher
           AND NOT EXISTS (SELECT 1 FROM "AssetValuation" b WHERE b."tenantId" = n."tenantId" AND b."assetId" = n."assetId"
             AND b."source" IN ('ASSESSOR', 'DEALER') AND b."valuedOn" >= today - max_age AND b."amountCents" > n."amountCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is re-based by staff only once its valuation has aged out, on the highest current valuation, at its amount';
    END IF;
    IF NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
  END IF;
  -- Notice ends an extension a month on (or at its last appended rental), given between the election and today.
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NOT (NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")) AND (
      NEW."outcome" <> 'EXTEND' OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
      OR NEW."extensionNoticeOn" > today OR NEW."extensionEndsOn" IS NULL
      -- On the first rental date (stepping a month at a time from the last rental, as the daily run appends
      -- them) at least a month after the notice and not before the billed period ends.
      OR (NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM (
        WITH RECURSIVE step(d, i) AS (
          SELECT MAX(r."dueDate"), 0 FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."cancelledAt" IS NULL
          UNION ALL SELECT (step.d + INTERVAL '1 month')::date, step.i + 1 FROM step WHERE step.i < 120)
        SELECT MIN(step.d) FROM step
        WHERE step.d >= GREATEST((NEW."extensionNoticeOn" + INTERVAL '1 month')::date, public."leaseTermEnd"(NEW."loanId", NEW."tenantId"))))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Notice is given between the election and today, and ends the extension on the first rental date a month after it and after the billed period';
  END IF;
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")
    AND (NEW."extensionNoticeOn" > today OR (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date > NEW."extensionNoticeOn"
      OR NEW."extensionEndsOn" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."extensionNoticeOn", 20)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A CPA lessee ends continuation on 20 business days notice';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'ELECTED' AND NEW."status" = 'INSPECTED' AND NEW."outcome" = 'RETURN')
    OR (OLD."status" = 'EXTENDING' AND NEW."status" = 'INSPECTED' AND NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" <= today)
    OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'INVOICED')
    OR (OLD."status" = 'ELECTED' AND NEW."status" = 'INVOICED' AND NEW."outcome" = 'PURCHASE')
    OR (OLD."status" = 'INVOICED' AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s end of term cannot move from %s to %s', NEW."outcome", OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'INSPECTED' AND OLD."status" <> 'INSPECTED' THEN
    -- The asset is inspected once it comes back: when the term (or the extension) ends, or on the accepted termination's date.
    returns_on := CASE
      WHEN NEW."origin" = 'EARLY_TERMINATION' THEN (SELECT q."terminationDate" FROM "LeaseTerminationQuote" q
        WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss"))
      WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"
      ELSE public."leaseTermEnd"(NEW."loanId", NEW."tenantId") END;
    IF returns_on IS NULL OR NEW."inspectedOn" < returns_on OR NEW."inspectedOn" > today
       OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A return is inspected from the day the asset comes back, after the election, never in the future';
    END IF;
    -- The final reading is this lease's asset's, taken at the inspection, and the latest.
    IF NEW."finalReadingId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."finalReadingId" AND m."tenantId" = NEW."tenantId"
          AND m."assetId" = loan_row."assetId" AND m."readingDate" = NEW."inspectedOn"
          AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" x WHERE x."tenantId" = m."tenantId" AND x."assetId" = m."assetId"
            AND x."unit" = m."unit" AND x."readingDate" > m."readingDate")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final reading is the lease''s asset''s latest, taken at the inspection';
    END IF;
  END IF;
  IF NEW."status" = 'INVOICED' AND OLD."status" = 'ELECTED' THEN
    -- A purchase is sold when the term ends, on a valuation still current.
    SELECT v."valuedOn" INTO valuation FROM "AssetValuation" v WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    IF today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR valuation."valuedOn" < today - max_age THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is invoiced when the term ends, on a current valuation';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."totalPaid" < r."totalDue") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term completes once everything owed on the lease is paid';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_termination_window";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_termination_window" CHECK (
 "lessorCancellation" OR "terminationDate" BETWEEN "quotedOn" AND "quotedOn" + 60
);

-- A credited future maintenance supply must not also be refunded by fund settlement.
ALTER TABLE "MaintenanceFundMovement" ADD COLUMN "creditedLeaseRentalId" TEXT;
CREATE UNIQUE INDEX "MaintenanceFundMovement_creditedLeaseRentalId_key" ON "MaintenanceFundMovement"("creditedLeaseRentalId");
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_creditedLeaseRentalId_key" ON "MaintenanceFundMovement"("tenantId", "creditedLeaseRentalId");
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_creditedLeaseRentalId_fkey"
 FOREIGN KEY ("tenantId", "creditedLeaseRentalId") REFERENCES "LeaseRental"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_credit_shape" CHECK (
 ("kind" = 'CONTRIBUTION_CREDIT') = ("creditedLeaseRentalId" IS NOT NULL)
);
CREATE OR REPLACE FUNCTION public."guardMaintenanceFundMovement"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE ok BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund movement is immutable';
  END IF;
  IF NEW."kind" = 'CONTRIBUTION' THEN
    SELECT EXISTS (SELECT 1 FROM "LeaseRental" r JOIN "MaintenanceFund" f ON f."loanId" = r."loanId" AND f."tenantId" = r."tenantId"
      WHERE r."id" = NEW."leaseRentalId" AND r."tenantId" = NEW."tenantId" AND f."id" = NEW."fundId" AND f."settledAt" IS NULL
        AND r."taxInvoiceId" IS NOT NULL AND r."maintenanceExclVatCents" = NEW."amountCents") INTO ok;
  ELSIF NEW."kind" = 'CONTRIBUTION_CREDIT' THEN
    SELECT EXISTS (SELECT 1 FROM "LeaseRental" r
      JOIN "MaintenanceFundMovement" original ON original."leaseRentalId" = r."id" AND original."tenantId" = r."tenantId" AND original."kind" = 'CONTRIBUTION'
      JOIN "MaintenanceFund" fund ON fund."id" = original."fundId" AND fund."tenantId" = original."tenantId"
      WHERE r."id" = NEW."creditedLeaseRentalId" AND r."tenantId" = NEW."tenantId" AND original."fundId" = NEW."fundId"
        AND original."amountCents" = NEW."amountCents" AND r."cancelledAt" IS NOT NULL AND r."cancellationCreditNoteId" IS NOT NULL
        AND fund."settledAt" IS NULL) INTO ok;
  ELSIF NEW."kind" = 'CLAIM' THEN
    SELECT EXISTS (SELECT 1 FROM "MaintenanceClaim" c JOIN "MaintenanceFund" f ON f."id" = c."fundId" AND f."tenantId" = c."tenantId"
      WHERE c."id" = NEW."claimId" AND c."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL
      AND c."fundId" = NEW."fundId" AND c."status" = 'PAID' AND c."amountExclVatCents" = NEW."amountCents") INTO ok;
  ELSE
    -- A settlement: of an unsettled lessee-settled fund, settled in the same
    -- transaction (checkSettlementMovement); a billed deficit on an invoice of the fund's loan.
    SELECT EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId"
      AND f."riskModel" = 'LESSEE_SETTLED' AND f."settledAt" IS NULL
      AND (NEW."kind" = 'SETTLEMENT_REFUND' OR EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId"
        AND i."tenantId" = NEW."tenantId" AND i."loanId" = f."loanId"))) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A %s movement must be backed by its rental, paid claim or a lessee-settled fund''s settlement', NEW."kind");
  END IF;
  RETURN NEW;
END;
$function$;
```

### prisma/migrations/20261017220000_lease_total_loss_event_date/migration.sql

Existing functions changed: none.

Exact proposed SQL:

```sql
ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_amounts";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_amounts" CHECK (
 "pvCents" >= 0 AND "penaltyCents" >= 0 AND "arrearsCents" >= 0 AND "invoiceVatCents" >= 0 AND "remainingRentals" >= 0
 AND "invoiceExclVatCents" >= 0 AND "insuranceProceedsCents" >= 0
 AND ("goodsValueCents" IS NULL OR "goodsValueCents" >= 0)
 AND jsonb_typeof("documentedCosts") = 'array'
 AND ((NOT "cpaCancellation" AND NOT "totalLoss" AND "invoiceExclVatCents" = "pvCents" + "penaltyCents")
   OR (("cpaCancellation" OR "totalLoss") AND "penaltyCents" = 0))
 AND "totalCents" = "invoiceExclVatCents" + "invoiceVatCents" + "arrearsCents"
 AND "validUntil" >= "quotedOn" AND ("lessorCancellation" OR "totalLoss" OR "terminationDate" >= "quotedOn")
 AND length(btrim("basis")) >= 10
 AND ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
 AND ("status" = 'ACCEPTED' OR ("taxInvoiceId" IS NULL AND "scheduleId" IS NULL))
 AND (NOT "totalLoss" OR length(btrim("lossEvidence")) > 0)
);
CREATE FUNCTION public."guardLeaseTotalLossEventDate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."totalLoss" AND (NEW."terminationDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date OR NOT EXISTS (
   SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
   AND NEW."terminationDate" >= (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)) THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Total loss event must be between commencement and today';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "LeaseTerminationQuote_loss_event_date" BEFORE INSERT OR UPDATE ON "LeaseTerminationQuote" FOR EACH ROW EXECUTE FUNCTION public."guardLeaseTotalLossEventDate"();
ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_termination_window";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_termination_window" CHECK (
 "lessorCancellation" OR "totalLoss" OR "terminationDate" BETWEEN "quotedOn" AND "quotedOn" + 60
);
```

### prisma/migrations/20261018003100_lease_total_loss_closure/migration.sql

Existing functions changed: `guardLeaseEndOfTerm`.

Exact proposed SQL:

```sql
CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  returns_on DATE;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF NEW."outcome" = 'TOTAL_LOSS' AND (NEW."origin" <> 'EARLY_TERMINATION' OR NOT EXISTS (
    SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."tenantId" = NEW."tenantId" AND q."loanId" = NEW."loanId"
      AND q."totalLoss" AND q."status" = 'ACCEPTED' AND NULLIF(btrim(q."lossEvidence"), '') IS NOT NULL
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss end needs the accepted evidenced loss of this lease';
  END IF;
  IF NEW."outcome" = 'TOTAL_LOSS' AND (NEW."inspectedOn" IS NOT NULL OR NEW."finalReadingId" IS NOT NULL
    OR NEW."inspectionCondition" IS NOT NULL OR NEW."inspectedById" IS NOT NULL OR NEW."excessUsageCents" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total loss is not a physical return or fabricated inspection';
  END IF;
  IF NEW."outcome" = 'TOTAL_LOSS' AND NEW."status" IN ('INVOICED', 'COMPLETED') AND (
    NOT EXISTS (SELECT 1 FROM "FinancedAsset" a WHERE a."id" = loan_row."assetId" AND a."tenantId" = NEW."tenantId" AND a."lessorStatus" = 'TOTAL_LOSS')
    OR EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."loanId" = NEW."loanId" AND f."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A billed total loss retains the lost asset state and settles its maintenance fund';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL
       OR NEW."inspectedOn" IS NOT NULL OR NEW."extensionNoticeOn" IS NOT NULL OR NEW."extensionEndsOn" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
    -- The elector changes only with a re-based purchase (the re-baser elects); purchase terms only while ELECTED.
    OR ((NEW."electedById" IS DISTINCT FROM OLD."electedById" OR NEW."electedByClientId" IS DISTINCT FROM OLD."electedByClientId")
      AND NOT (OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' AND NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."status" <> 'ELECTED' AND (NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents"
      OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
    OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
    OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
      OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition" OR NEW."inspectedById" IS DISTINCT FROM OLD."inspectedById"))
    OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn")
    OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn"
      AND NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND q."status" = 'ACCEPTED' AND q."lessorCancellation" AND q."terminationDate" = NEW."extensionEndsOn"))
    OR (OLD."natisTransferConfirmedAt" IS NOT NULL AND NEW."natisTransferConfirmedAt" IS DISTINCT FROM OLD."natisTransferConfirmedAt")
    OR (OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents" IS DISTINCT FROM OLD."excessUsageCents"
      OR NEW."fundSettlementCents" IS DISTINCT FROM OLD."fundSettlementCents")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
  END IF;
  -- An elected purchase is re-based only when its valuation has aged out: by staff (who become the
  -- elector), onto another valuation, at that valuation's amount, under the same rule as the election.
  IF NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId" THEN
    IF NEW."purchaseValuationId" IS NOT DISTINCT FROM OLD."purchaseValuationId" OR NEW."electedById" IS NULL OR NEW."electedByClientId" IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM "AssetValuation" o JOIN "AssetValuation" n ON n."id" = NEW."purchaseValuationId" AND n."tenantId" = o."tenantId"
         WHERE o."id" = OLD."purchaseValuationId" AND o."tenantId" = NEW."tenantId" AND o."valuedOn" < today - max_age
           AND NEW."purchasePriceExclVatCents" = n."amountCents"
           -- the house rule's valuation: no current market valuation of the asset is higher
           AND NOT EXISTS (SELECT 1 FROM "AssetValuation" b WHERE b."tenantId" = n."tenantId" AND b."assetId" = n."assetId"
             AND b."source" IN ('ASSESSOR', 'DEALER') AND b."valuedOn" >= today - max_age AND b."amountCents" > n."amountCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is re-based by staff only once its valuation has aged out, on the highest current valuation, at its amount';
    END IF;
    IF NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
  END IF;
  -- Notice ends an extension a month on (or at its last appended rental), given between the election and today.
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NOT (NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")) AND (
      NEW."outcome" <> 'EXTEND' OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
      OR NEW."extensionNoticeOn" > today OR NEW."extensionEndsOn" IS NULL
      -- On the first rental date (stepping a month at a time from the last rental, as the daily run appends
      -- them) at least a month after the notice and not before the billed period ends.
      OR (NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM (
        WITH RECURSIVE step(d, i) AS (
          SELECT MAX(r."dueDate"), 0 FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."cancelledAt" IS NULL
          UNION ALL SELECT (step.d + INTERVAL '1 month')::date, step.i + 1 FROM step WHERE step.i < 120)
        SELECT MIN(step.d) FROM step
        WHERE step.d >= GREATEST((NEW."extensionNoticeOn" + INTERVAL '1 month')::date, public."leaseTermEnd"(NEW."loanId", NEW."tenantId"))))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Notice is given between the election and today, and ends the extension on the first rental date a month after it and after the billed period';
  END IF;
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")
    AND (NEW."extensionNoticeOn" > today OR (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date > NEW."extensionNoticeOn"
      OR NEW."extensionEndsOn" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."extensionNoticeOn", 20)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A CPA lessee ends continuation on 20 business days notice';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'ELECTED' AND NEW."status" = 'INSPECTED' AND NEW."outcome" = 'RETURN')
    OR (OLD."status" = 'EXTENDING' AND NEW."status" = 'INSPECTED' AND NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" <= today)
    OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'INVOICED')
    OR (OLD."status" = 'ELECTED' AND NEW."status" = 'INVOICED' AND NEW."outcome" IN ('PURCHASE', 'TOTAL_LOSS'))
    OR (OLD."status" = 'INVOICED' AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s end of term cannot move from %s to %s', NEW."outcome", OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'INSPECTED' AND OLD."status" <> 'INSPECTED' THEN
    -- The asset is inspected once it comes back: when the term (or the extension) ends, or on the accepted termination's date.
    returns_on := CASE
      WHEN NEW."origin" = 'EARLY_TERMINATION' THEN (SELECT q."terminationDate" FROM "LeaseTerminationQuote" q
        WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss"))
      WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"
      ELSE public."leaseTermEnd"(NEW."loanId", NEW."tenantId") END;
    IF returns_on IS NULL OR NEW."inspectedOn" < returns_on OR NEW."inspectedOn" > today
       OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A return is inspected from the day the asset comes back, after the election, never in the future';
    END IF;
    -- The final reading is this lease's asset's, taken at the inspection, and the latest.
    IF NEW."finalReadingId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."finalReadingId" AND m."tenantId" = NEW."tenantId"
          AND m."assetId" = loan_row."assetId" AND m."readingDate" = NEW."inspectedOn"
          AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" x WHERE x."tenantId" = m."tenantId" AND x."assetId" = m."assetId"
            AND x."unit" = m."unit" AND x."readingDate" > m."readingDate")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final reading is the lease''s asset''s latest, taken at the inspection';
    END IF;
  END IF;
  IF NEW."status" = 'INVOICED' AND OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' THEN
    -- A purchase is sold when the term ends, on a valuation still current.
    SELECT v."valuedOn" INTO valuation FROM "AssetValuation" v WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    IF today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR valuation."valuedOn" < today - max_age THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is invoiced when the term ends, on a current valuation';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."totalPaid" < r."totalDue") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term completes once everything owed on the lease is paid';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Additional asset protections: a loss cannot become stock, a sale or a new financed asset.
CREATE FUNCTION public."guardTotalLossAsset"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."lessorStatus" = 'TOTAL_LOSS' AND NEW."lessorStatus" IS DISTINCT FROM OLD."lessorStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset cannot be returned to stock or sold';
  END IF;
  IF NEW."lessorStatus" = 'TOTAL_LOSS' AND NOT EXISTS (
    SELECT 1 FROM "Loan" l JOIN "LeaseTerminationQuote" q ON q."tenantId" = l."tenantId" AND q."loanId" = l."id"
      JOIN "LeaseEndOfTerm" e ON e."tenantId" = l."tenantId" AND e."loanId" = l."id"
    WHERE l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."id" AND q."totalLoss" AND q."status" = 'ACCEPTED'
      AND NULLIF(btrim(q."lossEvidence"), '') IS NOT NULL AND e."outcome" = 'TOTAL_LOSS'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset needs its accepted evidenced lease loss';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "FinancedAsset_total_loss_guard" BEFORE INSERT OR UPDATE ON "FinancedAsset"
FOR EACH ROW EXECUTE FUNCTION public."guardTotalLossAsset"();

CREATE FUNCTION public."guardNoTotalLossAssetFinancing"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" AND a."lessorStatus" = 'TOTAL_LOSS' FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset cannot be financed again';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetFinanceDeal_total_loss_guard" BEFORE INSERT OR UPDATE OF "assetId", "tenantId" ON "AssetFinanceDeal"
FOR EACH ROW EXECUTE FUNCTION public."guardNoTotalLossAssetFinancing"();
CREATE TRIGGER "Loan_total_loss_guard" BEFORE INSERT OR UPDATE OF "assetId", "tenantId" ON "Loan"
FOR EACH ROW EXECUTE FUNCTION public."guardNoTotalLossAssetFinancing"();

-- Actual external fund refunds after total loss: existing cash movements need evidence.
ALTER TABLE "MaintenanceFundMovement" ADD COLUMN "refundDocumentId" TEXT, ADD COLUMN "refundReference" TEXT;
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_refundDocumentId_fkey"
FOREIGN KEY ("tenantId", "refundDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_refundDocumentId_key" ON "MaintenanceFundMovement"("tenantId", "refundDocumentId");
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_refundReference_key" ON "MaintenanceFundMovement"("tenantId", "refundReference");
CREATE FUNCTION public."guardTotalLossFundRefund"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE loss_on DATE; lease_id TEXT; balance_cents BIGINT;
BEGIN
  SELECT f."loanId", q."terminationDate" INTO lease_id, loss_on FROM "MaintenanceFund" f
    JOIN "LeaseTerminationQuote" q ON q."tenantId" = f."tenantId" AND q."loanId" = f."loanId" AND q."totalLoss" AND q."status" = 'ACCEPTED'
    WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId";
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL THEN
    PERFORM 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId" FOR UPDATE;
    SELECT COALESCE(SUM(CASE WHEN m."kind" IN ('CONTRIBUTION', 'SETTLEMENT_BILLED') THEN m."amountCents" ELSE -m."amountCents" END), 0)
      INTO balance_cents FROM "MaintenanceFundMovement" m WHERE m."fundId" = NEW."fundId" AND m."tenantId" = NEW."tenantId";
    IF NEW."amountCents" <> balance_cents OR balance_cents <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss refund is the exact positive maintenance-fund surplus';
    END IF;
  END IF;
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL THEN
    PERFORM 1 FROM "EntityDocument" d WHERE d."id" = NEW."refundDocumentId" AND d."tenantId" = NEW."tenantId" FOR UPDATE;
    -- A separate live predicate below observes a delete that won the row lock.
  END IF;
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL AND (
    NEW."refundReference" IS NULL OR NEW."refundReference" <> upper(btrim(NEW."refundReference")) OR length(NEW."refundReference") NOT BETWEEN 1 AND 120
    OR NEW."occurredOn" < loss_on OR NEW."occurredOn" > (now() AT TIME ZONE 'Africa/Johannesburg')::date
    OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d JOIN "AssetFinanceDeal" a ON a."id" = d."dealId" AND a."tenantId" = d."tenantId"
      WHERE d."id" = NEW."refundDocumentId" AND d."tenantId" = NEW."tenantId" AND d."deletedAt" IS NULL AND d."uploadedByType" = 'staff'
        AND d."fileSize" > 0 AND a."loanId" = lease_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss maintenance refund requires actual date, unique bank reference and retained proof for this lease';
  END IF;
  IF (NEW."refundDocumentId" IS NOT NULL OR NEW."refundReference" IS NOT NULL) AND (NEW."kind" <> 'SETTLEMENT_REFUND' OR loss_on IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loss-refund evidence belongs only to this total-loss fund refund';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MaintenanceFundMovement_total_loss_refund_guard" BEFORE INSERT ON "MaintenanceFundMovement"
FOR EACH ROW EXECUTE FUNCTION public."guardTotalLossFundRefund"();

CREATE FUNCTION public."guardRetainedLossRefundProof"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "MaintenanceFundMovement" m WHERE m."tenantId" = OLD."tenantId" AND m."refundDocumentId" = OLD."id")
    AND (to_jsonb(NEW) - ARRAY['verifiedAt', 'verifiedById']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['verifiedAt', 'verifiedById']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An actual maintenance refund proof is retained';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "EntityDocument_loss_refund_retained_guard" BEFORE UPDATE ON "EntityDocument"
FOR EACH ROW EXECUTE FUNCTION public."guardRetainedLossRefundProof"();
```

### prisma/migrations/20261018110000_cpa_lessor_cancellation_assessment/migration.sql

Existing functions changed: `guardRecovery (two exact guarded anchor patches)`.

Exact proposed SQL:

```sql
-- Additive immutable assessment evidence; no expenses or bank cash are rewritten.
ALTER TABLE "LeaseTerminationQuote" ADD COLUMN "recoveryId" TEXT;
CREATE UNIQUE INDEX "LeaseTerminationQuote_recoveryId_key" ON "LeaseTerminationQuote"("recoveryId");
CREATE UNIQUE INDEX "LeaseTerminationQuote_tenantId_recoveryId_key" ON "LeaseTerminationQuote"("tenantId", "recoveryId");
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_tenantId_recoveryId_fkey"
FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION public."guardCpaLessorAssessment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a JSONB := NEW."reasonableAssessment";
  factor TEXT;
  field TEXT;
  rec RECORD;
  rental RECORD;
  cost RECORD;
  previous_day DATE := NEW."terminationDate";
  discount DOUBLE PRECISION := 1;
  pv DOUBLE PRECISION := 0;
  annual DOUBLE PRECISION;
  vat NUMERIC;
  remaining BIGINT := 0;
  actual_costs BIGINT;
  net_goods BIGINT;
  pv_gross BIGINT;
  ceiling BIGINT;
  assessed BIGINT;
  collectible BIGINT;
  damage BIGINT;
  allocation JSONB;
  allocation_index INTEGER := 0;
  budget BIGINT;
BEGIN
  -- Existing accepted-quote guard is the final immutable boundary; never reprice history.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'ACCEPTED' THEN RETURN NEW; END IF;
  IF NOT NEW."lessorCancellation" OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."cpaApplies") THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW."recoveryId" IS DISTINCT FROM OLD."recoveryId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: original recovery is immutable';
  END IF;
  IF NEW."status" <> 'ACCEPTED' THEN RETURN NEW; END IF;
  IF NEW."acceptedById" IS NULL OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR a->>'context' IS DISTINCT FROM 'lessor_breach_cpa48_contract9_10' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: staff must record a reasoned breach-cancellation charge';
  END IF;
  FOREACH factor IN ARRAY ARRAY['amountOwed','transactionValue','retainedGoods','returnedGoods','originalDuration','consumerLossesBenefits','natureOfGoods','noticeLength','alternativeConsumer','industryPractice'] LOOP
    IF jsonb_typeof(a->'factors'->factor) IS DISTINCT FROM 'string' OR NULLIF(btrim(a->'factors'->>factor), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: every applicable factor needs a case-specific finding';
    END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['rationale','fairnessReason'] LOOP
    IF jsonb_typeof(a->field) IS DISTINCT FROM 'string' OR NULLIF(btrim(a->>field), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: justify reasonableness and CPA s48 fairness';
    END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['assessedChargeCents','ceilingCents','pvExclVatCents','undiscountedRentalsCents','netProceedsCents','actualCostsCents','chargedCostsCents','costConcessionCents','damagesInclVatCents','damagesExclVatCents','vatRateTenThousandths'] LOOP
    IF jsonb_typeof(a->field) IS DISTINCT FROM 'number' OR (a->>field) !~ '^[0-9]+$' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: exact non-negative financial evidence required';
    END IF;
  END LOOP;
  SELECT r.*, s."priceInclVatCents" INTO rec FROM "Recovery" r JOIN "RemarketingSale" s ON s."recoveryId" = r."id" AND s."tenantId" = r."tenantId" AND s."status" = 'COMPLETED'
    WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" AND r."loanId" = NEW."loanId" AND r."status" = 'SOLD' FOR UPDATE OF r;
  IF NOT FOUND OR rec."recoveredOn" <> NEW."terminationDate" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: use this lease actual completed recovery and cancellation date';
  END IF;
  SELECT COALESCE(SUM(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0),
    GREATEST(0, rec."priceInclVatCents" - COALESCE(SUM(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0)) INTO actual_costs, net_goods
    FROM "RecoveryCost" c WHERE c."recoveryId" = rec."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
  SELECT COALESCE((SELECT cr."resultingRate" FROM "ContractRate" cr WHERE cr."loanId" = NEW."loanId" AND cr."tenantId" = NEW."tenantId" AND cr."effectiveDate" <= NEW."terminationDate" ORDER BY cr."effectiveDate" DESC LIMIT 1), l."interestRatePm" * 12) INTO annual
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  FOR rental IN SELECT r."dueDate", r."rentalExclVatCents" FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."dueDate" > NEW."terminationDate" ORDER BY r."dueDate" LOOP
    discount := discount * (1 + annual * (rental."dueDate" - previous_day) / 365);
    pv := pv + rental."rentalExclVatCents" / discount;
    remaining := remaining + rental."rentalExclVatCents";
    previous_day := rental."dueDate";
  END LOOP;
  SELECT v."rate" INTO vat FROM "VatRate" v WHERE v."effectiveDate" <= NEW."quotedOn" ORDER BY v."effectiveDate" DESC LIMIT 1;
  IF vat IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: supply-date VAT rate required'; END IF;
  pv_gross := round(pv::NUMERIC)::BIGINT + round(round(pv::NUMERIC) * vat)::BIGINT;
  ceiling := GREATEST(0, LEAST(pv_gross + actual_costs - net_goods, remaining - 1));
  assessed := (a->>'assessedChargeCents')::BIGINT;
  damage := LEAST(pv_gross, net_goods + assessed);
  collectible := LEAST(actual_costs, GREATEST(0, net_goods + assessed - damage));
  IF assessed > ceiling OR (a->>'ceilingCents')::BIGINT <> ceiling OR (a->>'pvExclVatCents')::BIGINT <> round(pv::NUMERIC)::BIGINT
    OR (a->>'undiscountedRentalsCents')::BIGINT <> remaining OR (a->>'netProceedsCents')::BIGINT <> net_goods
    OR (a->>'actualCostsCents')::BIGINT <> actual_costs OR (a->>'chargedCostsCents')::BIGINT <> collectible
    OR (a->>'costConcessionCents')::BIGINT <> actual_costs - collectible OR (a->>'damagesInclVatCents')::BIGINT <> damage
    OR (a->>'damagesExclVatCents')::BIGINT <> round(damage / (1 + vat))::BIGINT OR (a->>'vatRateTenThousandths')::BIGINT <> vat * 10000
    OR NEW."invoiceExclVatCents" <> round(damage / (1 + vat))::BIGINT OR NEW."invoiceVatCents" <> damage - NEW."invoiceExclVatCents" OR NEW."penaltyCents" <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: billed amounts and noncash concessions must match the assessed net charge within the independently computed ceiling';
  END IF;
  IF jsonb_typeof(a->'costAllocations') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: original cost-ID allocation required';
  END IF;
  budget := collectible;
  FOR cost IN SELECT c."id", c."grossCents" FROM "RecoveryCost" c WHERE c."recoveryId" = rec."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED' AND c."treatment" = 'CHARGE_TO_ACCOUNT' ORDER BY c."id" COLLATE "C" LOOP
    allocation := a->'costAllocations'->allocation_index;
    IF allocation->>'id' IS DISTINCT FROM cost."id" OR allocation->>'actualCents' IS DISTINCT FROM cost."grossCents"::TEXT
      OR allocation->>'collectibleCents' IS DISTINCT FROM LEAST(cost."grossCents", budget)::TEXT THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: original cost IDs and actual expense amounts are preserved with exact collectible allocation';
    END IF;
    budget := budget - LEAST(cost."grossCents", budget);
    allocation_index := allocation_index + 1;
  END LOOP;
  IF jsonb_array_length(a->'costAllocations') <> allocation_index THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_lessor_assessment: no invented cost allocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CpaLessorAssessment_guard" BEFORE INSERT OR UPDATE ON "LeaseTerminationQuote"
FOR EACH ROW EXECUTE FUNCTION public."guardCpaLessorAssessment"();

-- The same recovery lock orders assessment and cost changes; an accepted assessment fixes its expense inputs.
CREATE FUNCTION public."guardAssessedLessorCostsFinal"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."recoveryId" ELSE NEW."recoveryId" END;
  tenant TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
BEGIN
  PERFORM 1 FROM "Recovery" r WHERE r."id" = rec_id AND r."tenantId" = tenant FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."recoveryId" = rec_id AND q."tenantId" = tenant AND q."status" = 'ACCEPTED'
    AND q."reasonableAssessment"->>'context' = 'lessor_breach_cpa48_contract9_10') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An assessed lessor cancellation fixes its actual cost evidence';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "RecoveryCost_assessed_lessor_final_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryCost"
FOR EACH ROW EXECUTE FUNCTION public."guardAssessedLessorCostsFinal"();

-- §8: guarded unique-anchor patch of the currently installed function.
-- Preserve every sibling migration's surrender/surplus/receipt protection.
DO $patch$
DECLARE
  definition TEXT := pg_get_functiondef('public."guardRecovery"()'::regprocedure);
  cost_anchor TEXT := $cost_anchor$IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN$cost_anchor$;
  receipt_anchor TEXT := $receipt_anchor$expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");$receipt_anchor$;
BEGIN
  IF length(definition) - length(replace(definition, cost_anchor, '')) <> length(cost_anchor)
    OR length(definition) - length(replace(definition, receipt_anchor, '')) <> length(receipt_anchor) THEN
    RAISE EXCEPTION 'CPA lessor assessment guard patch requires each reviewed anchor exactly once';
  END IF;
  definition := replace(definition, cost_anchor, $cost_patch$
    -- Actual vendor expenses remain immutable; only the evidenced collectible customer allowance changes.
    IF EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND l."cpaApplies") THEN
      SELECT (q."reasonableAssessment"->>'chargedCostsCents')::BIGINT INTO costs.charged FROM "LeaseTerminationQuote" q
        WHERE q."recoveryId" = NEW."id" AND q."tenantId" = NEW."tenantId" AND q."loanId" = NEW."loanId"
          AND q."status" = 'ACCEPTED' AND q."lessorCancellation" AND q."reasonableAssessment"->>'context' = 'lessor_breach_cpa48_contract9_10';
      IF costs.charged IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A CPA lessor recovery requires its immutable reasoned cancellation assessment before proceeds';
      END IF;
    END IF;
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN$cost_patch$);
  definition := replace(definition, receipt_anchor, $receipt_patch$
    IF EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND l."cpaApplies") THEN
      -- Base settlement excludes the same separately stated certified cost allowance.
      expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents" + NEW."chargedCostsCents");
    ELSE
      expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    END IF;
$receipt_patch$);
  EXECUTE definition;
END;
$patch$;
```


## RATE — source checkpoint 652ed578

### prisma/migrations/20261017233000_asset_finance_rate_repricing_evidence/migration.sql

Existing functions changed: `validateLoanPasqV3Billing`.

Exact proposed SQL:

```sql
-- Ledger-only rates adjust a closed account separately until an active
-- schedule restatement consumes the pending correction without double credit.
CREATE FUNCTION public."assetRateIsLedgerOnly"(p_rate_id TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM "AssetFinanceRateCorrection" correction JOIN "ContractRate" rate ON rate."id" = correction."contractRateId"
    WHERE correction."contractRateId" = p_rate_id AND correction."reason" IN ('LATE_CLOSED_BOOK_RATE','FIXED_NOTICE_WINDOW_RATE','LATE_CLOSED_LEASE_RATE')
      AND NOT EXISTS (SELECT 1 FROM "AssetFinanceRateCorrection" applied JOIN "ContractRate" applied_rate ON applied_rate."id" = applied."contractRateId"
        WHERE applied."tenantId" = correction."tenantId" AND applied."loanId" = correction."loanId"
          AND applied."reason" = 'APPLIED_TO_SCHEDULE' AND applied_rate."effectiveDate" > rate."effectiveDate")
  );
END;
$$;

-- Authenticate a revised asset-finance contractual baseline without editing
-- the signed PASQ. Ordinary consumer LOAN contracts never enter this path.
CREATE OR REPLACE FUNCTION public."assetRateRepriceBaseline"(p_loan_id TEXT, p_original JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $function$
DECLARE
  booked RECORD;
  latest RECORD;
  baseline JSONB;
  expected JSONB;
  original_row JSONB;
  after_payoff BOOLEAN;
  ordinal BIGINT;
  previous_day DATE;
  due_day DATE;
  rate_days NUMERIC;
  expected_interest BIGINT;
  principal_sum BIGINT := 0;
  interest_sum BIGINT := 0;
  payment_sum BIGINT := 0;
  opening BIGINT;
  closing BIGINT;
  previous_closing BIGINT;
BEGIN
  SELECT l."tenantId", l."startDate", l."ncaRegime", l."contractType" INTO booked
  FROM "Loan" l WHERE l."id" = p_loan_id;
  IF NOT FOUND OR booked."ncaRegime" <> 'NCA' OR booked."contractType" NOT IN ('INSTALMENT_SALE', 'FINANCE_LEASE') THEN
    RETURN NULL;
  END IF;
  IF (SELECT COUNT(*) FROM "ContractRate" c WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")) < 2 THEN
    RETURN NULL;
  END IF;
  SELECT c.* INTO latest FROM "ContractRate" c
  WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")
  ORDER BY c."effectiveDate" DESC LIMIT 1;
  SELECT a."newValue" -> 'assetRateRepriceEvidence' INTO baseline FROM "AuditLog" a
  WHERE a."tenantId" = booked."tenantId" AND a."entity" = 'Loan' AND a."entityId" = p_loan_id
    AND a."action" = 'LOAN_REPRICED' AND a."newValue" ->> 'contractRateId' = latest."id"
    AND a."newValue" #>> '{assetRateRepriceEvidence,contractRateId}' = latest."id"
  ORDER BY a."createdAt" DESC, a."id" DESC LIMIT 1;
  IF baseline IS NULL OR baseline ->> 'version' IS DISTINCT FROM 'asset-rate-reprice-v1'
    OR baseline ->> 'originalEvidenceSha256' IS DISTINCT FROM p_original ->> 'evidenceSha256'
    OR baseline ->> 'effectiveDate' IS DISTINCT FROM latest."effectiveDate"::TEXT
    OR (CASE WHEN baseline ->> 'annualRate' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (baseline ->> 'annualRate')::NUMERIC IS DISTINCT FROM latest."resultingRate" ELSE TRUE END)
    OR JSONB_TYPEOF(baseline -> 'rows') IS DISTINCT FROM 'array'
    OR JSONB_ARRAY_LENGTH(baseline -> 'rows') <> JSONB_ARRAY_LENGTH(p_original #> '{billing,schedule}')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset rate repricing needs authentic contractual baseline evidence';
  END IF;
  -- The immutable ContractRate guard binds every point to its approved
  -- reference and the agreement's unchanged margin. Check the current point
  -- again so an audit marker alone is never approval evidence.
  IF latest."basis" = 'FIXED' OR NOT EXISTS (
    SELECT 1 FROM "ReferenceRate" r WHERE r."tenantId" = booked."tenantId" AND r."basis" = latest."basis"
      AND r."status" = 'APPROVED' AND r."effectiveDate" <= latest."effectiveDate"
      AND r."rate" + latest."margin" = latest."resultingRate"
      AND NOT EXISTS (SELECT 1 FROM "ReferenceRate" newer WHERE newer."tenantId" = r."tenantId"
        AND newer."basis" = r."basis" AND newer."status" = 'APPROVED'
        AND newer."effectiveDate" > r."effectiveDate" AND newer."effectiveDate" <= latest."effectiveDate")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset rate repricing needs its approved reference-rate path';
  END IF;
  previous_day := (booked."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE;
  FOR expected, ordinal IN SELECT value, ordinality FROM JSONB_ARRAY_ELEMENTS(baseline -> 'rows') WITH ORDINALITY LOOP
    original_row := p_original #> ARRAY['billing', 'schedule', (ordinal - 1)::TEXT];
    after_payoff := baseline ? 'payoff' AND ((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'Africa/Johannesburg')::DATE > (baseline #>> '{payoff,date}')::DATE;
    IF expected ->> 'installmentNo' IS DISTINCT FROM original_row ->> 'installmentNo'
      OR expected ->> 'dueDate' IS DISTINCT FROM original_row ->> 'dueDate'
      OR (NOT COALESCE(after_payoff,FALSE) AND (expected ->> 'feesDueCents' IS DISTINCT FROM original_row ->> 'feesDueCents' OR expected ->> 'baseFeesDueCents' IS DISTINCT FROM original_row ->> 'baseFeesDueCents' OR expected ->> 'creditLifePremiumDueCents' IS DISTINCT FROM original_row ->> 'creditLifePremiumDueCents'))
      OR (after_payoff AND ((expected ->> 'totalDueCents')::BIGINT <> 0 OR (expected ->> 'feesDueCents')::BIGINT <> 0 OR (expected ->> 'creditLifePremiumDueCents')::BIGINT <> 0))
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['principalDueCents','interestDueCents','totalDueCents','openingBalanceCents','closingBalanceCents']) key
        WHERE NOT COALESCE(expected ->> key ~ '^[0-9]+$', FALSE))
      OR (expected ->> 'totalDueCents')::BIGINT <> (expected ->> 'principalDueCents')::BIGINT
        + (expected ->> 'interestDueCents')::BIGINT + (expected ->> 'feesDueCents')::BIGINT
      OR NOT EXISTS (SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = expected ->> 'id'
        AND s."loanId" = p_loan_id AND s."tenantId" = booked."tenantId"
        AND s."installmentNo" = (expected ->> 'installmentNo')::INTEGER)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing preserves signed dates, fees, premiums and row identities';
    END IF;
    opening := (expected ->> 'openingBalanceCents')::BIGINT;
    closing := (expected ->> 'closingBalanceCents')::BIGINT;
    IF (ordinal = 1 AND opening <> (p_original #>> '{calculator,principalCents}')::BIGINT)
      OR (ordinal > 1 AND opening IS DISTINCT FROM previous_closing)
      OR closing <> opening - (expected ->> 'principalDueCents')::BIGINT
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing must preserve the interest-bearing principal without capitalising fees or interest';
    END IF;
    due_day := ((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'Africa/Johannesburg')::DATE;
    SELECT COALESCE(SUM(path."resultingRate" * GREATEST(0,
      LEAST(COALESCE(path.next_day - 1, due_day), due_day) - GREATEST(path."effectiveDate", previous_day + 1) + 1)), 0)
    INTO rate_days FROM (
      SELECT c."effectiveDate", c."resultingRate", LEAD(c."effectiveDate") OVER (ORDER BY c."effectiveDate") AS next_day
      FROM "ContractRate" c WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")
    ) path;
    expected_interest := ROUND(opening * rate_days / 365)::BIGINT;
    IF (expected ->> 'interestDueCents')::BIGINT <> expected_interest THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing interest must follow the approved path from each effective day';
    END IF;
    previous_day := due_day;
    previous_closing := closing;
    principal_sum := principal_sum + (expected ->> 'principalDueCents')::BIGINT;
    interest_sum := interest_sum + expected_interest;
    payment_sum := payment_sum + (expected ->> 'totalDueCents')::BIGINT;
  END LOOP;
  IF previous_closing <> 0 OR principal_sum <> (p_original #>> '{calculator,principalCents}')::BIGINT
    OR interest_sum <> (baseline ->> 'totalInterestCents')::BIGINT
    OR payment_sum <> (baseline ->> 'totalRepayableCents')::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing baseline totals must reconcile to its contractual rows';
  END IF;
  IF baseline ? 'payoff' AND (
    NOT EXISTS (SELECT 1 FROM "AssetFinanceRateCorrection" correction WHERE correction."contractRateId" = latest."id" AND correction."reason" = 'RATE_PAYOFF_CREDIT')
    OR (baseline #>> '{payoff,refundDueCents}')::BIGINT <> (SELECT COALESCE(SUM(p."amount"),0) FROM "Payment" p WHERE p."tenantId" = booked."tenantId" AND p."loanId" = p_loan_id AND NOT p."reversed" AND p."allocationStatus" = 'UNAPPLIED' AND p."reconciliationReason" = 'asset_rate_payoff_credit' AND p."reconciliationReference" = latest."id")
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rate payoff needs its conserved pending cash refund'; END IF;
  RETURN baseline;
END;
$function$;

-- Raw request metadata on another audit action cannot forge the monetary
-- evidence consumed by the deferred PASQ guard.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_asset_rate_evidence_action" CHECK (
  NOT COALESCE("newValue" ? 'assetRateRepriceEvidence', FALSE)
  OR ("action" = 'LOAN_REPRICED' AND "entity" = 'Loan' AND "entityId" IS NOT NULL
    AND JSONB_TYPEOF("newValue" -> 'assetRateRepriceEvidence') = 'object')
);

-- Existing consumer validator, unchanged outside the asset-only prelude.
CREATE OR REPLACE FUNCTION public."validateLoanPasqV3Billing"(p_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  expected_schedule_count INTEGER;
  evidence_total_interest INTEGER;
  evidence_total_repayable INTEGER;
  actual_schedule_count INTEGER;
  actual_total_due BIGINT;
  actual_premium_due BIGINT;
  allocated_payment_total BIGINT;
  early_daily_settlement BOOLEAN;
  early_instalment_settlement BOOLEAN;
  actual_total_interest BIGINT;
  settled RECORD;
  revised_asset_baseline JSONB;
  settle_day DATE;
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
    loan."ncaRegime",
    loan."contractType",
    loan."applicationId",
    loan."clientId",
    loan."productId",
    loan."principal",
    loan."totalInterest",
    loan."initiationFee",
    loan."creditLifePremiums",
    loan."totalRepayable",
    loan."contractualTotalInterest",
    loan."contractualTotalRepayable",
    loan."totalPaid",
    loan."outstandingPrincipal",
    loan."status",
    loan."closedAt",
    loan."interestModel",
    application."pasqVersion",
    application."pasqEvidence"
  INTO booked
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
  WHERE loan."id" = p_loan_id;

  IF NOT FOUND OR booked."pasqVersion" IS DISTINCT FROM 'pasq-v3' THEN
    RETURN;
  END IF;

  -- NCA asset contracts alone may have an authenticated reference repricing.
  -- The signed PASQ is never updated. Its revised contractual money is used
  -- locally below by the unchanged normal / s125 / reversal checks.
  IF booked."ncaRegime" = 'NCA' AND booked."contractType" IN ('INSTALMENT_SALE', 'FINANCE_LEASE') THEN
    revised_asset_baseline := public."assetRateRepriceBaseline"(booked."id", booked."pasqEvidence");
    IF revised_asset_baseline IS NOT NULL THEN
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{calculator,totalInterestCents}', revised_asset_baseline -> 'totalInterestCents');
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{billing,totalRepayableCents}', revised_asset_baseline -> 'totalRepayableCents');
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{billing,schedule}', revised_asset_baseline -> 'rows');
      IF revised_asset_baseline ? 'payoff' THEN
        SELECT COALESCE(SUM((item ->> 'creditLifePremiumDueCents')::BIGINT),0) INTO booked."creditLifePremiums" FROM JSONB_ARRAY_ELEMENTS(revised_asset_baseline -> 'rows') item;
        booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{creditLife,totalPremiumCents}', TO_JSONB(booked."creditLifePremiums"));
      END IF;
    END IF;
  END IF;

  IF
    JSONB_TYPEOF(booked."pasqEvidence") <> 'object'
    OR JSONB_TYPEOF(booked."pasqEvidence" #> '{billing,schedule}') <> 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  evidence_total_interest :=
    (booked."pasqEvidence" #>> '{calculator,totalInterestCents}')::INTEGER;
  evidence_total_repayable :=
    (booked."pasqEvidence" #>> '{billing,totalRepayableCents}')::INTEGER;
  expected_schedule_count :=
    JSONB_ARRAY_LENGTH(booked."pasqEvidence" #> '{billing,schedule}');

  IF
    booked."tenantId" <> booked."pasqEvidence" ->> 'tenantId'
    OR booked."applicationId" <> booked."pasqEvidence" ->> 'applicationId'
    OR booked."clientId" <> booked."pasqEvidence" ->> 'clientId'
    OR booked."productId" <> booked."pasqEvidence" ->> 'productId'
    OR booked."principal"
      <> (booked."pasqEvidence" #>> '{calculator,principalCents}')::INTEGER
    OR booked."initiationFee"
      <> (booked."pasqEvidence" #>> '{calculator,initiationFeeCents}')::INTEGER
    OR booked."creditLifePremiums"
      <> (booked."pasqEvidence" #>> '{creditLife,totalPremiumCents}')::INTEGER
    OR (
      booked."contractualTotalInterest" IS NOT NULL
      AND booked."contractualTotalInterest" <> evidence_total_interest
    )
    OR (
      booked."contractualTotalRepayable" IS NOT NULL
      AND booked."contractualTotalRepayable" <> evidence_total_repayable
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  early_daily_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" = 'DAILY_ACCRUAL'::"InterestModel"
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalInterest" < evidence_total_interest
    AND booked."totalRepayable" < evidence_total_repayable;

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(schedule."totalDue"), 0),
    COALESCE(SUM(schedule."creditLifePremiumDue"), 0)
  INTO actual_schedule_count, actual_total_due, actual_premium_due
  FROM "RepaymentSchedule" AS schedule
  WHERE schedule."loanId" = booked."id";

  IF early_daily_settlement THEN
    SELECT COALESCE(SUM(payment."amount"), 0)
    INTO allocated_payment_total
    FROM "Payment" AS payment
    WHERE payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

    IF
      expected_schedule_count <> 1
      OR actual_schedule_count <> 1
      OR booked."totalInterest" < 0
      OR booked."totalRepayable"
        <> evidence_total_repayable
          - evidence_total_interest
          + booked."totalInterest"
      OR booked."totalPaid" <> booked."totalRepayable"
      OR allocated_payment_total <> booked."totalPaid"
      OR booked."outstandingPrincipal" <> 0
      OR booked."closedAt" IS NULL
      OR actual_total_due <> booked."totalRepayable"
      OR actual_premium_due <> booked."creditLifePremiums"
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        LEFT JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE
          actual."id" IS NULL
          OR actual."tenantId" <> booked."tenantId"
          OR actual."principalDue"
            <> (expected ->> 'principalDueCents')::INTEGER
          OR actual."interestDue" <> booked."totalInterest"
          OR actual."creditLifePremiumDue"
            <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
          OR actual."feesDue"
            <> (expected ->> 'feesDueCents')::INTEGER
          OR actual."totalDue" <> booked."totalRepayable"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "Payment" AS payment
        JOIN "AuditLog" AS audit
          ON audit."tenantId" = booked."tenantId"
          AND (
            audit."newValue" ->> 'paymentId' = payment."id"
            OR (
              audit."entity" = 'Payment'
              AND audit."entityId" = payment."id"
            )
          )
        WHERE payment."loanId" = booked."id"
          AND payment."tenantId" = booked."tenantId"
          AND payment."reversed" = FALSE
          AND payment."allocationStatus"
            = 'ALLOCATED'::"PaymentAllocationStatus"
          AND audit."newValue" ->> 'earlyDailySettlement' = 'true'
          AND CASE
            WHEN audit."newValue" ->> 'accruedInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'accruedInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'interestRebate' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'interestRebate')::BIGINT
          END = evidence_total_interest - booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalRepayable')::BIGINT
          END = booked."totalRepayable"
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalInterest')::BIGINT
          END = evidence_total_interest
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalRepayable')::BIGINT
          END = evidence_total_repayable
          AND CASE
            WHEN audit."newValue" ->> 'settlementDue' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'settlementDue')::BIGINT
          END = payment."amount"
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early DAILY_ACCRUAL settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;
    RETURN;
  END IF;

  -- NCA s125 early settlement of an instalment agreement
  -- (lib/loan/s125-settlement.ts): rows not yet due at the settlement date are
  -- re-priced down to what they earned (principal, pro-rata interest of the
  -- current period, a deferred initiation fee) and the loan closes.
  --
  -- The settlement is the receipt a receipt writer's audit row names: a live,
  -- allocated payment on this loan whose amount is the settlement figure the
  -- row records, and whose row records the contractual rows it re-priced,
  -- which match the PASQ exactly (a reversal restores the schedule from them).
  -- The settlement date is that payment's value date: every row due by then is
  -- owed exactly as acknowledged; of the rows after it only the first carries
  -- interest, none carries a premium or a fee but the deferred initiation fee
  -- in instalment 1, and nothing rises above the PASQ.
  early_instalment_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" <> 'DAILY_ACCRUAL'::"InterestModel"
    AND expected_schedule_count > 1
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalRepayable" < evidence_total_repayable;

  IF early_instalment_settlement THEN
    SELECT payment."id", payment."receivedAt"
    INTO settled
    FROM "AuditLog" AS audit
    JOIN "Payment" AS payment
      ON payment."id" = audit."newValue" ->> 'paymentId'
      AND payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus"
        = 'ALLOCATED'::"PaymentAllocationStatus"
    WHERE audit."tenantId" = booked."tenantId"
      AND (
        (
          audit."action" IN ('PAYMENT_RECORDED', 'SMALL_BALANCE_WAIVED')
          AND audit."entity" = 'Loan'
          AND audit."entityId" = booked."id"
        )
        OR (
          audit."action" = 'PAYMENT_ALLOCATED'
          AND audit."entity" = 'Payment'
          AND audit."entityId" = payment."id"
        )
        OR (
          audit."action" = 'BANK_TXN_RECONCILED'
          AND audit."entity" = 'BankTransaction'
          AND EXISTS (
            SELECT 1
            FROM "BankTransaction" AS deposit
            WHERE deposit."id" = audit."entityId"
              AND deposit."tenantId" = booked."tenantId"
              AND deposit."paymentId" = payment."id"
          )
        )
      )
      AND audit."newValue" ->> 'earlyInstalmentSettlement' = 'true'
      AND audit."newValue" ->> 'loanId' = booked."id"
      AND CASE
        WHEN audit."newValue" ->> 'settlementDue' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'settlementDue')::BIGINT
      END = payment."amount"
      AND CASE
        WHEN audit."newValue" ->> 'resultingTotalInterest' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'resultingTotalInterest')::BIGINT
      END = booked."totalInterest"
      AND CASE
        WHEN audit."newValue" ->> 'resultingTotalRepayable' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'resultingTotalRepayable')::BIGINT
      END = booked."totalRepayable"
      AND CASE
        WHEN audit."newValue" ->> 'interestRebate' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'interestRebate')::BIGINT
      END = evidence_total_interest - booked."totalInterest"
      AND CASE
        WHEN audit."newValue" ->> 'contractualTotalInterest' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'contractualTotalInterest')::BIGINT
      END = evidence_total_interest
      AND CASE
        WHEN audit."newValue" ->> 'contractualTotalRepayable' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'contractualTotalRepayable')::BIGINT
      END = evidence_total_repayable
      AND JSONB_TYPEOF(audit."newValue" -> 'contractualRows') = 'array'
      AND JSONB_ARRAY_LENGTH(audit."newValue" -> 'contractualRows')
        = expected_schedule_count
      AND NOT EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        WHERE NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            audit."newValue" -> 'contractualRows'
          ) AS recorded
          JOIN "RepaymentSchedule" AS own
            ON own."id" = recorded ->> 'id'
            AND own."loanId" = booked."id"
            AND own."installmentNo"
              = (expected ->> 'installmentNo')::INTEGER
          WHERE recorded ->> 'installmentNo' = expected ->> 'installmentNo'
            AND recorded ->> 'principalDue' = expected ->> 'principalDueCents'
            AND recorded ->> 'interestDue' = expected ->> 'interestDueCents'
            AND recorded ->> 'feesDue' = expected ->> 'feesDueCents'
            AND recorded ->> 'creditLifePremiumDue'
              = expected ->> 'creditLifePremiumDueCents'
            AND recorded ->> 'totalDue' = expected ->> 'totalDueCents'
        )
      )
    ORDER BY audit."createdAt" DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;

    settle_day :=
      (settled."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE;

    SELECT COALESCE(SUM(
      payment."amount" - payment."defaultInterestAllocated" - payment."chargeFeesAllocated"
    ), 0)
    INTO allocated_payment_total
    FROM "Payment" AS payment
    WHERE payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

    SELECT COALESCE(SUM(schedule."interestDue"), 0)
    INTO actual_total_interest
    FROM "RepaymentSchedule" AS schedule
    WHERE schedule."loanId" = booked."id";

    IF
      actual_schedule_count <> expected_schedule_count
      OR booked."totalInterest" < 0
      OR actual_total_interest <> booked."totalInterest"
      OR actual_total_due <> booked."totalRepayable"
      OR booked."totalPaid" <> booked."totalRepayable"
      OR allocated_payment_total <> booked."totalPaid"
      OR booked."outstandingPrincipal" <> 0
      OR booked."closedAt" IS NULL
      OR actual_premium_due > booked."creditLifePremiums"
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        LEFT JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE
          actual."id" IS NULL
          OR actual."tenantId" <> booked."tenantId"
          OR actual."principalDue"
            <> (expected ->> 'principalDueCents')::INTEGER
          OR actual."totalDue"
            <> actual."principalDue" + actual."interestDue" + actual."feesDue"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
          OR CASE
            WHEN (actual."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE
              <= settle_day
            THEN
              actual."interestDue"
                <> (expected ->> 'interestDueCents')::INTEGER
              OR actual."feesDue"
                <> (expected ->> 'feesDueCents')::INTEGER
              OR actual."creditLifePremiumDue"
                <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
            ELSE
              actual."creditLifePremiumDue" <> 0
              OR actual."feesDue" < 0
              OR actual."feesDue" > CASE
                WHEN actual."installmentNo" = 1
                THEN LEAST(
                  booked."initiationFee",
                  (expected ->> 'feesDueCents')::INTEGER
                )
                ELSE 0
              END
              OR actual."interestDue" < 0
              OR actual."interestDue"
                > (expected ->> 'interestDueCents')::INTEGER
              OR (
                actual."interestDue" > 0
                AND EXISTS (
                  SELECT 1
                  FROM "RepaymentSchedule" AS earlier
                  WHERE earlier."loanId" = booked."id"
                    AND earlier."installmentNo" < actual."installmentNo"
                    AND (earlier."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE
                      > settle_day
                )
              )
          END
      )
      OR EXISTS (
        SELECT 1
        FROM "RepaymentSchedule" AS actual
        WHERE actual."loanId" = booked."id"
          AND NOT EXISTS (
            SELECT 1
            FROM JSONB_ARRAY_ELEMENTS(
              booked."pasqEvidence" #> '{billing,schedule}'
            ) AS expected
            WHERE (expected ->> 'installmentNo')::INTEGER
              = actual."installmentNo"
          )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;
    RETURN;
  END IF;

  IF
    booked."totalInterest" <> evidence_total_interest
    OR booked."totalRepayable" <> evidence_total_repayable
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  IF
    actual_schedule_count <> expected_schedule_count
    OR actual_total_due <> booked."totalRepayable"
    OR actual_premium_due <> booked."creditLifePremiums"
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(
        booked."pasqEvidence" #> '{billing,schedule}'
      ) AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE
        actual."id" IS NULL
        OR actual."tenantId" <> booked."tenantId"
        OR actual."principalDue"
          <> (expected ->> 'principalDueCents')::INTEGER
        OR actual."interestDue"
          <> (expected ->> 'interestDueCents')::INTEGER
        OR actual."creditLifePremiumDue"
          <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
        OR actual."feesDue"
          <> (expected ->> 'feesDueCents')::INTEGER
        OR actual."totalDue"
          <> (expected ->> 'totalDueCents')::INTEGER
    )
    OR EXISTS (
      SELECT 1
      FROM "RepaymentSchedule" AS actual
      WHERE actual."loanId" = booked."id"
        AND NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            booked."pasqEvidence" #> '{billing,schedule}'
          ) AS expected
          WHERE (expected ->> 'installmentNo')::INTEGER
            = actual."installmentNo"
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Repayment schedule does not match the acknowledged PASQ v3 billing evidence';
  END IF;
END;

$function$;
```

