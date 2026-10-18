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
