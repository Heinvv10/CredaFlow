ALTER TABLE "AssetFinanceRateNotice"
  ADD COLUMN "statutoryDueOn" DATE,
  ADD COLUMN "firstDispatchedAt" TIMESTAMP(3),
  ADD COLUMN "deadlineExceptionAt" TIMESTAMP(3),
  ADD COLUMN "deadlineEscalationLevel" INTEGER NOT NULL DEFAULT 0;

-- Legacy completedAt is application workflow state, not provider evidence.
-- Leave firstDispatchedAt NULL unless authentic Message timestamps are proven.
UPDATE "AssetFinanceRateNotice" n
SET "statutoryDueOn" = public."recoveryAddBusinessDays"(n."effectiveDate", 30)
FROM "Loan" l
WHERE l.id = n."loanId" AND l."tenantId" = n."tenantId" AND l."ncaRegime" = 'NCA';

-- New enforcement only: no baseline function or existing CHECK is replaced.
CREATE FUNCTION public."guardRateNoticeDeadline"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  expected DATE;
  actual_effective DATE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r."effectiveDate",
           CASE WHEN l."ncaRegime" = 'NCA'
             THEN public."recoveryAddBusinessDays"(r."effectiveDate", 30)
             ELSE NULL
           END
    INTO actual_effective, expected
    FROM "Loan" l
    JOIN "ContractRate" r
      ON r."loanId" = l.id AND r."tenantId" = l."tenantId" AND r.id = NEW."contractRateId"
    WHERE l.id = NEW."loanId" AND l."tenantId" = NEW."tenantId";

    IF NEW."effectiveDate" IS DISTINCT FROM actual_effective
       OR NEW."statutoryDueOn" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Rate notice deadline must follow actual effective date and NCA regime'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."statutoryDueOn" IS DISTINCT FROM OLD."statutoryDueOn"
       OR NEW."effectiveDate" IS DISTINCT FROM OLD."effectiveDate"
       OR NEW."loanId" IS DISTINCT FROM OLD."loanId"
       OR NEW."contractRateId" IS DISTINCT FROM OLD."contractRateId" THEN
      RAISE EXCEPTION 'Rate notice statutory obligation is immutable' USING ERRCODE = '23514';
    END IF;
    IF (OLD."firstDispatchedAt" IS NOT NULL AND NEW."firstDispatchedAt" IS DISTINCT FROM OLD."firstDispatchedAt")
       OR (OLD."deadlineExceptionAt" IS NOT NULL AND NEW."deadlineExceptionAt" IS DISTINCT FROM OLD."deadlineExceptionAt")
       OR NEW."deadlineEscalationLevel" < OLD."deadlineEscalationLevel" THEN
      RAISE EXCEPTION 'Rate notice compliance history cannot be cleared' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceRateNotice_deadline_guard"
  BEFORE INSERT OR UPDATE ON "AssetFinanceRateNotice"
  FOR EACH ROW EXECUTE FUNCTION public."guardRateNoticeDeadline"();
