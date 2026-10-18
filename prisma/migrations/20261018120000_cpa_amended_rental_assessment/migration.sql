-- Match amendedLeaseRentals without changing original rentals, corrections or accepted history.
CREATE FUNCTION public."leaseAmendedRentalCents"(tenant_id TEXT, loan_id TEXT, period_no INTEGER, original_cents INTEGER)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $function$
DECLARE
  source RECORD;
  part JSONB;
  evidence JSONB;
  cents NUMERIC := original_cents;
BEGIN
  FOR source IN SELECT c."reason", c."contractualRows" FROM "AssetFinanceRateCorrection" c
    WHERE c."tenantId" = tenant_id AND c."loanId" = loan_id
      AND c."reason" IN ('LATE_CLOSED_LEASE_RATE','RATE_PAYOFF_CREDIT','LEASE_SUPPLY_TAX_CANCELLED') LOOP
    evidence := source."contractualRows";
    IF source."reason" = 'LEASE_SUPPLY_TAX_CANCELLED' AND evidence->'replacedByRentalFloor' = 'true'::JSONB
      AND evidence->'periodNo' = to_jsonb(period_no) THEN
      cents := cents + COALESCE((evidence->>'exclVatAdjustmentCents')::NUMERIC, 0);
    END IF;
    IF jsonb_typeof(evidence->'periodAdjustments') = 'array' THEN
      FOR part IN SELECT value FROM jsonb_array_elements(evidence->'periodAdjustments') LOOP
        IF part->'periodNo' = to_jsonb(period_no) AND jsonb_typeof(part->'exclVatCents') = 'number' THEN
          cents := cents + (part->>'exclVatCents')::NUMERIC;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF cents < 0 OR cents <> trunc(cents) OR cents > 9007199254740991 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Amended rental consideration must be non-negative exact cents';
  END IF;
  RETURN cents::BIGINT;
END;
$function$;

-- Patch the installed guards only at their rental projection. Every other
-- factor, financial equality, ownership, immutable-history and allocation check survives.
DO $patch$
DECLARE
  body TEXT := pg_get_functiondef('public."guardCpaLessorAssessment"()'::regprocedure);
  anchor TEXT := $anchor$SELECT r."dueDate", r."rentalExclVatCents" FROM "LeaseRental" r WHERE$anchor$;
  replacement TEXT := $replacement$SELECT r."dueDate", public."leaseAmendedRentalCents"(r."tenantId", r."loanId", r."periodNo", r."rentalExclVatCents") AS "rentalExclVatCents" FROM "LeaseRental" r WHERE$replacement$;
BEGIN
  IF (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one guardCpaLessorAssessment rental projection anchor';
  END IF;
  EXECUTE replace(body, anchor, replacement);
END;
$patch$;

DO $patch$
DECLARE
  body TEXT := pg_get_functiondef('public."guardCpaReasonableAssessment"()'::regprocedure);
  anchor TEXT := $anchor$SUM(r."rentalExclVatCents")$anchor$;
  replacement TEXT := $replacement$SUM(public."leaseAmendedRentalCents"(r."tenantId", r."loanId", r."periodNo", r."rentalExclVatCents"))$replacement$;
BEGIN
  IF (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one guardCpaReasonableAssessment rental projection anchor';
  END IF;
  EXECUTE replace(body, anchor, replacement);
END;
$patch$;

