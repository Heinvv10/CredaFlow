-- W6 review round 3 (scan on 20261015260000):
--  (1) every provider report not applied (stale, dropped, refused) is kept in
--      PayoutUnappliedReport and stays on the outstanding-payouts queue until
--      a person acknowledges it, once, with a note (lib/payouts/
--      unapplied-reports.ts). Never changed otherwise, never deleted.
--  (2) a reopen never lowers the stored conflict state
--      (guardDisbursementPayout = the 20261015260000 version plus that rule),
--      and the conflict fields stay consistent
--      (DisbursementPayout_conflict_consistency: event time not after
--      receipt; an event id only with a report; a resolution not before the
--      report it resolves). NOT VALID: it holds every write from now on.
-- Exercised by lib/payouts/unapplied-reports.integration.test.ts.

-- CreateTable
CREATE TABLE "PayoutUnappliedReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "reported" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "eventId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgementNote" TEXT,

    CONSTRAINT "PayoutUnappliedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutUnappliedReport_tenantId_acknowledgedAt_createdAt_idx" ON "PayoutUnappliedReport"("tenantId", "acknowledgedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "PayoutUnappliedReport" ADD CONSTRAINT "PayoutUnappliedReport_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "DisbursementPayout"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "PayoutUnappliedReport" ADD CONSTRAINT "PayoutUnappliedReport_outcome"
  CHECK ("outcome" IN ('stale', 'dropped', 'rejected'));

CREATE OR REPLACE FUNCTION public."guardPayoutUnappliedReport"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a report not applied is never deleted; acknowledge it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."acknowledgedAt" IS NOT NULL OR NEW."acknowledgedById" IS NOT NULL OR NEW."acknowledgementNote" IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."id" = NEW."payoutId" AND p."tenantId" = NEW."tenantId")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a report not applied is recorded unacknowledged, against a payout of its tenant';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'acknowledgedAt' - 'acknowledgedById' - 'acknowledgementNote')
    IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledgedAt' - 'acknowledgedById' - 'acknowledgementNote')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a report not applied is kept as recorded';
  END IF;
  IF OLD."acknowledgedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a report not applied is acknowledged once';
  END IF;
  IF NEW."acknowledgedAt" IS NULL OR NEW."acknowledgedById" IS NULL OR length(trim(coalesce(NEW."acknowledgementNote", ''))) < 5 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a report not applied is acknowledged by a named person, with a note';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardPayoutUnappliedReport"
  BEFORE INSERT OR UPDATE OR DELETE ON "PayoutUnappliedReport"
  FOR EACH ROW EXECUTE FUNCTION public."guardPayoutUnappliedReport"();

ALTER TABLE "DisbursementPayout" ADD CONSTRAINT "DisbursementPayout_conflict_consistency"
  CHECK (
    ("providerConflictEventAt" IS NULL OR ("providerConflictAt" IS NOT NULL AND "providerConflictEventAt" <= "providerConflictAt"))
    AND ("providerConflictEventId" IS NULL OR "providerConflictAt" IS NOT NULL)
    AND ("conflictResolvedAt" IS NULL OR "conflictResolvedAt" >= "providerConflictAt")
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public."guardDisbursementPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  loan_application TEXT;
  loan_status TEXT;
  previous RECORD;
  core_changed BOOLEAN;
  conflict_moves BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."submittedAt" IS NOT NULL OR NEW."providerReference" IS NOT NULL OR NEW."paidAt" IS NOT NULL OR NEW."returnedAt" IS NOT NULL
      OR NEW."providerConflictAt" IS NOT NULL OR NEW."conflictResolvedAt" IS NOT NULL
      OR NEW."returnedById" IS NOT NULL OR NEW."returnNote" IS NOT NULL
      OR NEW."providerConflictEventId" IS NOT NULL OR NEW."providerConflictEventAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout is created unsent';
    END IF;
    SELECT l."applicationId", l."status"::TEXT INTO loan_application, loan_status FROM "Loan" l
      WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_application IS DISTINCT FROM NEW."applicationId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a payout pays the loan booked from its own application';
    END IF;
    IF loan_status NOT IN ('ACTIVE', 'DEFAULTED') OR EXISTS (
      SELECT 1 FROM "DisbursementReversal" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."status" <> 'REJECTED'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: no payout for a loan that is not active or whose reversal is open';
    END IF;
    IF NEW."attempt" = 1 THEN
      IF NEW."status" <> 'PENDING' OR NEW."retryOfId" IS NOT NULL OR NEW."disbursedById" IS DISTINCT FROM NEW."createdById" THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Payout guard: a payout is created PENDING and unsent, by the disburser';
      END IF;
      RETURN NEW;
    END IF;
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
    IF EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId"
      AND p."providerConflictAt" IS NOT NULL AND p."conflictResolvedAt" IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Payout guard: a provider reported money moving on an attempt already over; resolve that first';
    END IF;
    RETURN NEW;
  END IF;

  -- One clock for every report and decision: the database's.
  IF NEW."providerConflictAt" IS NOT NULL AND NEW."providerConflictAt" IS DISTINCT FROM OLD."providerConflictAt" THEN
    NEW."providerConflictAt" := clock_timestamp();
    NEW."providerConflictEventAt" := LEAST(COALESCE(NEW."providerConflictEventAt", NEW."providerConflictAt"), NEW."providerConflictAt");
  END IF;
  IF OLD."conflictResolvedAt" IS NULL AND NEW."conflictResolvedAt" IS NOT NULL THEN
    NEW."conflictResolvedAt" := clock_timestamp();
  END IF;

  -- The conflict columns move only these ways (lib/payouts/conflicts.ts): a
  -- stronger report (PAID > RETURNED) overwrites an unresolved conflict; a
  -- RETURNED after an unresolved PAID becomes PAID_THEN_RETURNED, final; or a
  -- newer PAID/RETURNED report reopens a resolved one (clearing the
  -- resolution) unless the money is already a recovery case.
  conflict_moves := OLD."status" IN ('FAILED', 'CANCELLED') AND NEW."status" = OLD."status"
    AND OLD."providerConflictAt" IS NOT NULL
    AND NEW."providerConflictState" IN ('PAID', 'RETURNED', 'PAID_THEN_RETURNED') AND NEW."providerConflictDetail" IS NOT NULL
    AND NEW."providerConflictAt" IS NOT NULL AND NEW."providerConflictAt" >= OLD."providerConflictAt"
    AND (
      (OLD."conflictResolvedAt" IS NULL AND NEW."conflictResolvedAt" IS NULL AND (
        (OLD."providerConflictState" IN ('PAID', 'RETURNED') AND NEW."providerConflictState" = 'PAID_THEN_RETURNED')
        OR (NEW."providerConflictState" IN ('PAID', 'RETURNED')
          AND (CASE NEW."providerConflictState" WHEN 'PAID' THEN 4 WHEN 'RETURNED' THEN 3 ELSE 0 END)
            > (CASE OLD."providerConflictState" WHEN 'PAID_THEN_RETURNED' THEN 5 WHEN 'PAID' THEN 4 WHEN 'RETURNED' THEN 3
                 WHEN 'PROCESSING' THEN 2 WHEN 'SUBMITTED' THEN 1 ELSE 0 END))))
      OR (OLD."conflictResolvedAt" IS NOT NULL AND NEW."providerConflictState" IN ('PAID', 'RETURNED', 'PAID_THEN_RETURNED')
        AND NEW."conflictResolvedAt" IS NULL AND NEW."conflictResolvedById" IS NULL AND NEW."conflictResolutionNote" IS NULL
        -- Any new report reopens (receipt is stamped above from the database
        -- clock, so it is after the decision); the very event the decision was
        -- made on never does (code also ignores any event id seen before).
        AND NEW."providerConflictAt" > OLD."conflictResolvedAt"
        AND (NEW."providerConflictEventId" IS NULL OR NEW."providerConflictEventId" IS DISTINCT FROM OLD."providerConflictEventId")
        AND NOT EXISTS (SELECT 1 FROM "PayoutRecoveryCase" rc WHERE rc."payoutId" = NEW."id")
        -- A new event never lowers what is known (PAID_THEN_RETURNED > PAID > RETURNED).
        AND (CASE NEW."providerConflictState" WHEN 'PAID_THEN_RETURNED' THEN 5 WHEN 'PAID' THEN 4 WHEN 'RETURNED' THEN 3 ELSE 0 END)
          >= (CASE OLD."providerConflictState" WHEN 'PAID_THEN_RETURNED' THEN 5 WHEN 'PAID' THEN 4 WHEN 'RETURNED' THEN 3
                WHEN 'PROCESSING' THEN 2 WHEN 'SUBMITTED' THEN 1 ELSE 0 END))
    );

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
    OR (OLD."providerConflictAt" IS NOT NULL AND NOT conflict_moves AND (
      NEW."providerConflictAt" IS DISTINCT FROM OLD."providerConflictAt"
      OR NEW."providerConflictState" IS DISTINCT FROM OLD."providerConflictState"
      OR NEW."providerConflictDetail" IS DISTINCT FROM OLD."providerConflictDetail"
      OR NEW."providerConflictEventId" IS DISTINCT FROM OLD."providerConflictEventId"
      OR NEW."providerConflictEventAt" IS DISTINCT FROM OLD."providerConflictEventAt"))
    OR (OLD."conflictResolvedAt" IS NOT NULL AND NOT conflict_moves AND (
      NEW."conflictResolvedAt" IS DISTINCT FROM OLD."conflictResolvedAt"
      OR NEW."conflictResolvedById" IS DISTINCT FROM OLD."conflictResolvedById"
      OR NEW."conflictResolutionNote" IS DISTINCT FROM OLD."conflictResolutionNote"))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a payout''s terms never change';
  END IF;
  -- Maker-checker: whoever settles a payout, or resolves a provider conflict,
  -- by hand is neither the disburser, the attempt's requester nor its approver.
  IF (OLD."resolvedById" IS NULL AND NEW."resolvedById" IS NOT NULL
      AND (NEW."resolvedById" IN (NEW."disbursedById", NEW."createdById") OR NEW."resolvedById" = NEW."approvedById"))
    OR (OLD."conflictResolvedById" IS NULL AND NEW."conflictResolvedById" IS NOT NULL
      AND (NEW."conflictResolvedById" IN (NEW."disbursedById", NEW."createdById") OR NEW."conflictResolvedById" = NEW."approvedById"))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: the disburser, the requester or the approver cannot settle this payout';
  END IF;
  -- A return confirmed by staff (lib/payouts/resolve.ts confirm_returned): on a
  -- PAID payout, by a named second person with a note, once.
  IF (OLD."returnedById" IS NOT NULL AND (NEW."returnedById" IS DISTINCT FROM OLD."returnedById" OR NEW."returnNote" IS DISTINCT FROM OLD."returnNote"))
    OR (OLD."returnedById" IS NULL AND (NEW."returnedById" IS NOT NULL OR NEW."returnNote" IS NOT NULL)
      AND (NEW."returnedById" IS NULL OR NEW."returnNote" IS NULL OR OLD."status" <> 'PAID' OR NEW."status" <> 'RETURNED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a return confirmed by staff is by a named person with a note, once, on a paid payout';
  END IF;
  IF OLD."returnedById" IS NULL AND NEW."returnedById" IS NOT NULL
    AND (NEW."returnedById" IN (NEW."disbursedById", NEW."createdById") OR NEW."returnedById" = NEW."approvedById")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: the disburser, the requester or the approver cannot settle this payout';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF OLD."status" IN ('PAID', 'FAILED', 'RETURNED', 'CANCELLED') THEN
      -- A settled payout changes only by recording, then resolving, a provider conflict.
      core_changed := NEW."simulated" IS DISTINCT FROM OLD."simulated"
        OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
        OR NEW."failureReason" IS DISTINCT FROM OLD."failureReason"
        OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
        OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
        OR NEW."resolvedById" IS DISTINCT FROM OLD."resolvedById"
        OR NEW."resolutionNote" IS DISTINCT FROM OLD."resolutionNote"
        OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
        OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
        OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
        OR NEW."returnedAt" IS DISTINCT FROM OLD."returnedAt"
        OR NEW."returnedById" IS DISTINCT FROM OLD."returnedById"
        OR NEW."returnNote" IS DISTINCT FROM OLD."returnNote";
      IF core_changed OR (OLD."providerConflictAt" IS NULL AND NEW."providerConflictAt" IS NOT NULL AND OLD."status" NOT IN ('FAILED', 'CANCELLED')) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Payout guard: a settled payout is immutable';
      END IF;
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
    -- A provider conflict resolved as "the money did go out".
    OR (OLD."status" IN ('FAILED', 'CANCELLED') AND NEW."status" = 'PAID'
      AND OLD."providerConflictState" = 'PAID' AND OLD."conflictResolvedAt" IS NULL AND NEW."conflictResolvedAt" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Payout guard: %s -> %s is not allowed', OLD."status", NEW."status");
  END IF;
  -- Nothing is approved or sent while any attempt of the loan carries an
  -- unresolved provider conflict: a late PAID report may mean the money left.
  IF ((OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" = 'PENDING') OR (OLD."status" = 'PENDING' AND NEW."status" = 'SUBMITTING'))
    AND EXISTS (SELECT 1 FROM "DisbursementPayout" p WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId"
      AND p."providerConflictAt" IS NOT NULL AND p."conflictResolvedAt" IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: a provider reported money moving on an attempt already over; resolve that first';
  END IF;
  -- A late PAID report resolved as paid stands only if no other attempt of the
  -- application is paid or in flight: two payouts never stand.
  IF OLD."status" IN ('FAILED', 'CANCELLED') AND NEW."status" = 'PAID' AND EXISTS (
    SELECT 1 FROM "DisbursementPayout" p WHERE p."applicationId" = NEW."applicationId" AND p."id" <> NEW."id"
      AND p."status" NOT IN ('FAILED', 'RETURNED', 'CANCELLED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: another attempt of this payout is paid or in flight; the money went out twice and must be recovered first';
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
  IF OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" = 'PENDING' AND (
    (SELECT l."status"::TEXT FROM "Loan" l WHERE l."id" = NEW."loanId") NOT IN ('ACTIVE', 'DEFAULTED')
    OR EXISTS (SELECT 1 FROM "DisbursementReversal" r WHERE r."loanId" = NEW."loanId" AND r."status" <> 'REJECTED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payout guard: no payout for a loan that is not active or whose reversal is open';
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
