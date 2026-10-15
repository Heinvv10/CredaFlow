-- W6 review round 3 (accounting review), on PayoutRecoveryCase:
--  - "recovered" records the amount staff entered, and only the full case
--    amount counts (a part is escalated instead);
--  - a case may be closed UNRECOVERABLE from OPEN or ESCALATED, and that is
--    final (the accounting export writes the money off to bad debts that day);
--  - segregation of duties on every step: never the disburser, the attempt's
--    creator or approver, or the case's opener; and whoever escalated a case
--    does not also close it (recovered or unrecoverable).
-- Exercised by lib/payouts/payout-recovery.integration.test.ts.

-- AlterTable
ALTER TABLE "PayoutRecoveryCase" ADD COLUMN     "recoveredAmountCents" INTEGER,
ADD COLUMN     "unrecoverableAt" TIMESTAMP(3),
ADD COLUMN     "unrecoverableById" TEXT,
ADD COLUMN     "unrecoverableNote" TEXT;

-- 20261015210100 version, plus the recovered amount, UNRECOVERABLE, and the
-- opener and escalator exclusions.
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
      OR NEW."recoveredAt" IS NOT NULL OR NEW."recoveredById" IS NOT NULL OR NEW."recoveredAmountCents" IS NOT NULL
      OR NEW."unrecoverableAt" IS NOT NULL OR NEW."unrecoverableById" IS NOT NULL
      OR length(trim(NEW."openNote")) < 5
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
  IF OLD."status" IN ('RECOVERED', 'UNRECOVERABLE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: a recovered or unrecoverable case is closed';
  END IF;
  -- Whatever the step, the escalation already recorded never changes.
  IF OLD."status" = 'ESCALATED' AND (NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt"
    OR NEW."escalatedById" IS DISTINCT FROM OLD."escalatedById" OR NEW."escalationNote" IS DISTINCT FROM OLD."escalationNote")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: an escalation is recorded once';
  END IF;
  IF OLD."status" = 'OPEN' AND NEW."status" = 'ESCALATED' THEN
    IF NEW."escalatedAt" IS NULL OR NEW."escalatedById" IS NULL OR length(trim(coalesce(NEW."escalationNote", ''))) < 5
      OR NEW."recoveredAt" IS NOT NULL OR NEW."recoveredById" IS NOT NULL OR NEW."recoveredAmountCents" IS NOT NULL
      OR NEW."unrecoverableAt" IS NOT NULL OR NEW."unrecoverableById" IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: an escalation names who, when and why';
    END IF;
    actor := NEW."escalatedById";
  ELSIF NEW."status" = 'RECOVERED' THEN
    IF NEW."recoveredAmountCents" IS DISTINCT FROM OLD."amountCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: only the full amount is recorded recovered; escalate a part';
    END IF;
    IF NEW."recoveredAt" IS NULL OR NEW."recoveredById" IS NULL OR length(trim(coalesce(NEW."recoveryNote", ''))) < 5
      OR NEW."recoveredAt" < OLD."paidAt"
      OR NEW."unrecoverableAt" IS NOT NULL OR NEW."unrecoverableById" IS NOT NULL
      OR (OLD."status" = 'OPEN' AND (NEW."escalatedAt" IS NOT NULL OR NEW."escalatedById" IS NOT NULL))
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: a recovery names who, when (not before the money left) and how';
    END IF;
    actor := NEW."recoveredById";
  ELSIF NEW."status" = 'UNRECOVERABLE' THEN
    IF NEW."unrecoverableAt" IS NULL OR NEW."unrecoverableById" IS NULL OR length(trim(coalesce(NEW."unrecoverableNote", ''))) < 5
      OR NEW."unrecoverableAt" < OLD."paidAt"
      OR NEW."recoveredAt" IS NOT NULL OR NEW."recoveredById" IS NOT NULL OR NEW."recoveredAmountCents" IS NOT NULL
      OR (OLD."status" = 'OPEN' AND (NEW."escalatedAt" IS NOT NULL OR NEW."escalatedById" IS NOT NULL))
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Recovery guard: closing a case as unrecoverable names who, when (not before the money left) and why';
    END IF;
    actor := NEW."unrecoverableById";
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: a case goes OPEN -> ESCALATED -> RECOVERED or UNRECOVERABLE (either also straight from OPEN)';
  END IF;
  IF actor IN (p."disbursedById", p."createdById", coalesce(p."approvedById", ''), OLD."openedById") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: someone other than the people who made or approved this payout, opened the case, acts on its recovery';
  END IF;
  IF OLD."status" = 'ESCALATED' AND actor = OLD."escalatedById" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Recovery guard: whoever escalated it does not also close it';
  END IF;
  RETURN NEW;
END;
$function$;
