-- ---------------------------------------------------------------------------
-- Hand-written (asset finance repricing, docs/asset-finance/DESIGN.md D4)
-- ---------------------------------------------------------------------------
--
-- No RepaymentSchedule trigger exemption is needed for repricing a NON_NCA
-- loan's PENDING rows: the PASQ v3 schedule guards (validateLoanPasqV3Billing,
-- validateLoanPasqV3ScheduleDates) return at once unless the application's
-- pasqVersion is 'pasq-v3', and LoanApplication_approved_status_requires_pasq
-- (20261013090000_asset_finance_foundation) requires pasqVersion IS NULL on an
-- APPROVED or DISBURSED NON_NCA application. Proven against a migrated
-- database by lib/asset-finance/reprice-loan.integration.test.ts.

-- A contract rate is either fixed or a reference plus a margin, never both and
-- never neither, and its basis says which.
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_fixed_xor_margin" CHECK (num_nonnulls("margin", "fixedRate") = 1);
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_fixed_basis" CHECK (("basis" = 'FIXED') = ("fixedRate" IS NOT NULL));
-- A fixed rate is its own resulting rate.
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_fixed_resulting_rate" CHECK ("basis" <> 'FIXED' OR "resultingRate" = "fixedRate");
-- Annual nominal rate as a decimal (0.1275 = 12.75%).
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_resulting_rate_range" CHECK ("resultingRate" >= 0 AND "resultingRate" <= 1);

-- A loan's rate history is append-only: a contract rate is never updated,
-- deleted or truncated; a change is a new row from a later date. A new row
-- belongs to a NON_NCA asset-finance contract (slice 1 reprices nothing else),
-- takes effect no more than a year ahead, never before the loan's latest
-- contract rate (the first row: never before the loan's start date, SAST), and,
-- when it is reference-linked, its resulting rate is exactly the APPROVED
-- reference rate of its basis in force on its date plus its margin (decimal
-- equality, no rounding: both are DECIMAL(9,6)). A fixed row's resulting rate
-- is its fixed rate (CHECK ContractRate_fixed_resulting_rate). After the
-- first row, a new row keeps the loan's terms: the basis and margin (or the
-- fixed rate) of the loan's latest row, exactly; only the resulting rate moves
-- with the reference. Both writers satisfy all of that: booking inserts the
-- start-date row from the reference value then in force, and repricing
-- (lib/asset-finance/reprice-loan.ts) inserts a row on the approved reference
-- change's own date at that reference + the prior basis and margin. A change
-- of basis or margin is a contract variation, refused.
-- PARTIAL: variations need a re-signed agreement; slice 1 has no such flow.
-- An equal date is let through to the unique index
-- ContractRate_loanId_effectiveDate_key, whose P2002 repricing reads as
-- already_repriced. Inserts for one loan are serialised by an advisory lock,
-- so two concurrent inserts cannot both pass the "not before the latest" test.
CREATE OR REPLACE FUNCTION public."guardContractRate"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  loan_start DATE;
  latest DATE;
  previous RECORD;
  reference_rate NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ContractRate is insert-only: %s refused (a rate change is a new row)', TG_OP);
  END IF;
  SELECT (loan."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO loan_start
  FROM "Loan" AS loan
  WHERE loan."id" = NEW."loanId" AND loan."tenantId" = NEW."tenantId"
    AND loan."ncaRegime" = 'NON_NCA' AND loan."contractType" <> 'LOAN';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate belongs to a NON_NCA asset-finance contract of the same tenant';
  END IF;
  IF NEW."effectiveDate" > (current_date + INTERVAL '1 year')::date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate may not take effect more than a year ahead';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contract-rate:' || NEW."loanId", 0));
  SELECT c."effectiveDate", c."basis", c."margin", c."fixedRate" INTO previous
  FROM "ContractRate" AS c WHERE c."loanId" = NEW."loanId"
  ORDER BY c."effectiveDate" DESC LIMIT 1;
  latest := previous."effectiveDate";
  IF NEW."effectiveDate" < coalesce(latest, loan_start) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('A contract rate may not take effect before %s (the loan''s %s)',
        coalesce(latest, loan_start), CASE WHEN latest IS NULL THEN 'start date' ELSE 'latest contract rate' END);
  END IF;
  -- PARTIAL: variations need a re-signed agreement (slice 1 refuses them).
  IF latest IS NOT NULL AND (
    NEW."basis" IS DISTINCT FROM previous."basis"
    OR NEW."margin" IS DISTINCT FROM previous."margin"
    OR NEW."fixedRate" IS DISTINCT FROM previous."fixedRate"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('A contract rate keeps the loan''s basis and margin (or fixed rate) of %s: a change is a contract variation, refused',
        latest);
  END IF;
  IF NEW."basis" <> 'FIXED' THEN
    SELECT reference."rate" INTO reference_rate FROM "ReferenceRate" AS reference
    WHERE reference."tenantId" = NEW."tenantId" AND reference."basis" = NEW."basis"
      AND reference."status" = 'APPROVED' AND reference."effectiveDate" <= NEW."effectiveDate"
    ORDER BY reference."effectiveDate" DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A reference-linked contract rate needs an approved reference rate of its basis in effect on its date';
    END IF;
    -- A NULL margin is left to CHECK ContractRate_fixed_xor_margin.
    IF NEW."margin" IS NOT NULL AND NEW."resultingRate" IS DISTINCT FROM reference_rate + NEW."margin" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('A reference-linked contract rate''s resulting rate must be the approved %s rate in force on its date (%s) plus its margin',
          NEW."basis", reference_rate);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ContractRate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ContractRate" FOR EACH ROW EXECUTE FUNCTION "guardContractRate"();
CREATE TRIGGER "ContractRate_no_truncate" BEFORE TRUNCATE ON "ContractRate" FOR EACH STATEMENT EXECUTE FUNCTION "guardContractRate"();
