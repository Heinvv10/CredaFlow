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
-- Annual nominal rate as a decimal (0.1275 = 12.75%).
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_resulting_rate_range" CHECK ("resultingRate" >= 0 AND "resultingRate" <= 1);

-- A loan's rate history is append-only: a contract rate is never updated,
-- deleted or truncated; a change is a new row from a later date. A new row
-- belongs to a NON_NCA asset-finance contract (slice 1 reprices nothing else),
-- takes effect no more than a year ahead, and, when it is reference-linked,
-- builds on an APPROVED reference rate of its basis in effect on its date.
-- Both writers satisfy that: booking inserts the start-date row from the
-- reference value then in force, and repricing inserts a row on the approved
-- reference change's own date. (A tighter bound, "on or before the latest
-- approved reference date", would refuse booking whenever the reference was
-- last changed before the start date.)
CREATE OR REPLACE FUNCTION public."guardContractRate"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ContractRate is insert-only: %s refused (a rate change is a new row)', TG_OP);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Loan" AS loan
    WHERE loan."id" = NEW."loanId" AND loan."tenantId" = NEW."tenantId"
      AND loan."ncaRegime" = 'NON_NCA' AND loan."contractType" <> 'LOAN'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate belongs to a NON_NCA asset-finance contract of the same tenant';
  END IF;
  IF NEW."effectiveDate" > (current_date + INTERVAL '1 year')::date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate may not take effect more than a year ahead';
  END IF;
  IF NEW."basis" <> 'FIXED' AND NOT EXISTS (
    SELECT 1 FROM "ReferenceRate" AS reference
    WHERE reference."tenantId" = NEW."tenantId" AND reference."basis" = NEW."basis"
      AND reference."status" = 'APPROVED' AND reference."effectiveDate" <= NEW."effectiveDate"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A reference-linked contract rate needs an approved reference rate of its basis in effect on its date';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ContractRate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ContractRate" FOR EACH ROW EXECUTE FUNCTION "guardContractRate"();
CREATE TRIGGER "ContractRate_no_truncate" BEFORE TRUNCATE ON "ContractRate" FOR EACH STATEMENT EXECUTE FUNCTION "guardContractRate"();
