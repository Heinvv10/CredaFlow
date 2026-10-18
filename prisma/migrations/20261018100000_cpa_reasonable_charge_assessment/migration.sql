-- Additive assessment guard, shipped with staff assessment code. Existing accepted
-- quotes remain historical; no invoice is silently recomputed or backfilled.
ALTER TABLE "LeaseTerminationQuote" ADD COLUMN "reasonableAssessment" JSONB;
CREATE FUNCTION public."guardCpaReasonableAssessment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assessment JSONB := NEW."reasonableAssessment";
  factor TEXT;
  assessed BIGINT;
  ceiling BIGINT;
  remaining BIGINT;
  costs BIGINT;
BEGIN
  IF NEW."status" <> 'ACCEPTED' OR NOT NEW."cpaCancellation" OR NEW."totalLoss" OR NEW."lessorCancellation" THEN RETURN NEW; END IF;
  IF jsonb_typeof(assessment) IS DISTINCT FROM 'object' OR NEW."acceptedById" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_reasonable_assessment: staff must assess the reasonable charge';
  END IF;
  FOREACH factor IN ARRAY ARRAY['amountOwed', 'transactionValue', 'retainedGoods', 'returnedGoods', 'originalDuration', 'consumerLossesBenefits', 'natureOfGoods', 'noticeLength', 'alternativeConsumer', 'industryPractice'] LOOP
    IF jsonb_typeof(assessment->'factors'->factor) IS DISTINCT FROM 'string'
      OR NULLIF(btrim(assessment->'factors'->>factor), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_reasonable_assessment: every Regulation 5(2) factor needs a case-specific finding';
    END IF;
  END LOOP;
  IF jsonb_typeof(assessment->'rationale') IS DISTINCT FROM 'string' OR NULLIF(btrim(assessment->>'rationale'), '') IS NULL
    OR jsonb_typeof(assessment->'cancellationRightReason') IS DISTINCT FROM 'string' OR NULLIF(btrim(assessment->>'cancellationRightReason'), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_reasonable_assessment: justify reasonableness and preservation of the right to cancel';
  END IF;
  IF jsonb_typeof(assessment->'assessedChargeCents') IS DISTINCT FROM 'number' OR (assessment->>'assessedChargeCents') !~ '^[0-9]+$'
    OR jsonb_typeof(assessment->'ceilingCents') IS DISTINCT FROM 'number' OR (assessment->>'ceilingCents') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_reasonable_assessment: exact non-negative amounts required';
  END IF;
  assessed := (assessment->>'assessedChargeCents')::BIGINT;
  SELECT COALESCE(SUM(r."rentalExclVatCents"), 0) INTO remaining FROM "LeaseRental" r
    WHERE r."tenantId" = NEW."tenantId" AND r."loanId" = NEW."loanId" AND r."dueDate" > NEW."terminationDate";
  SELECT COALESCE(SUM((c->>'amountCents')::BIGINT), 0) INTO costs FROM jsonb_array_elements(NEW."documentedCosts") c;
  ceiling := GREATEST(0, LEAST(NEW."pvCents"::BIGINT - NEW."goodsValueCents" + costs, remaining - 1));
  IF NEW."goodsValueCents" IS NULL OR (assessment->>'ceilingCents')::BIGINT <> ceiling
    OR assessed > ceiling OR NEW."invoiceExclVatCents" <> assessed OR NEW."penaltyCents" <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cpa_reasonable_assessment: billed charge must equal assessed amount within the financial ceiling';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CpaReasonableAssessment_guard" BEFORE INSERT OR UPDATE ON "LeaseTerminationQuote"
FOR EACH ROW EXECUTE FUNCTION public."guardCpaReasonableAssessment"();
