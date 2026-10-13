-- NCA asset loans use the same immutable contract-rate history. The separate
-- NCA cap trigger still rejects a rate above the prescribed ceiling.
CREATE OR REPLACE FUNCTION public."guardContractRate"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  loan_start DATE;
  loan_application TEXT;
  latest DATE;
  previous RECORD;
  deal_terms RECORD;
  reference_rate NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('ContractRate is insert-only: %s refused (a rate change is a new row)', TG_OP);
  END IF;
  SELECT (loan."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date, loan."applicationId"
  INTO loan_start, loan_application
  FROM "Loan" AS loan
  WHERE loan."id" = NEW."loanId" AND loan."tenantId" = NEW."tenantId" AND loan."contractType" <> 'LOAN';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A contract rate belongs to an asset-finance contract of the same tenant';
  END IF;
  IF NEW."effectiveDate" > (current_date + INTERVAL '1 year')::date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A contract rate may not take effect more than a year ahead';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contract-rate:' || NEW."loanId", 0));
  SELECT c."effectiveDate", c."basis", c."margin", c."fixedRate" INTO previous
  FROM "ContractRate" AS c WHERE c."loanId" = NEW."loanId" ORDER BY c."effectiveDate" DESC LIMIT 1;
  latest := previous."effectiveDate";
  IF NEW."effectiveDate" < coalesce(latest, loan_start) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A contract rate may not take effect before %s (the loan''s %s)', coalesce(latest, loan_start), CASE WHEN latest IS NULL THEN 'start date' ELSE 'latest contract rate' END);
  END IF;
  IF latest IS NULL THEN
    SELECT d."rateBasis", d."rateMargin", d."fixedRate" INTO deal_terms
    FROM "AssetFinanceDeal" d WHERE d."applicationId" = loan_application AND d."tenantId" = NEW."tenantId";
    IF FOUND AND (
      NEW."effectiveDate" <> loan_start OR NEW."basis" IS DISTINCT FROM deal_terms."rateBasis"
      OR (NEW."basis" = 'FIXED' AND NEW."fixedRate" IS DISTINCT FROM deal_terms."fixedRate")
      OR (NEW."basis" <> 'FIXED' AND NEW."margin" IS DISTINCT FROM deal_terms."rateMargin")
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan''s first contract rate is its deal''s basis and margin (or fixed rate), effective on the loan''s start date';
    END IF;
  END IF;
  IF latest IS NOT NULL AND (
    NEW."basis" IS DISTINCT FROM previous."basis" OR NEW."margin" IS DISTINCT FROM previous."margin" OR NEW."fixedRate" IS DISTINCT FROM previous."fixedRate"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A contract rate keeps the loan''s basis and margin (or fixed rate) of %s: a change is a contract variation, refused', latest);
  END IF;
  IF NEW."basis" <> 'FIXED' THEN
    SELECT reference."rate" INTO reference_rate FROM "ReferenceRate" AS reference
    WHERE reference."tenantId" = NEW."tenantId" AND reference."basis" = NEW."basis"
      AND reference."status" = 'APPROVED' AND reference."effectiveDate" <= NEW."effectiveDate"
    ORDER BY reference."effectiveDate" DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A reference-linked contract rate needs an approved reference rate of its basis in effect on its date';
    END IF;
    IF NEW."margin" IS NOT NULL AND NEW."resultingRate" IS DISTINCT FROM reference_rate + NEW."margin" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A reference-linked contract rate''s resulting rate must be the approved %s rate in force on its date (%s) plus its margin', NEW."basis", reference_rate);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
