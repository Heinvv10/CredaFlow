-- Fair Score audit B6: at or below the R1,000 credit-life threshold cover cannot
-- be added, so an application there records the no-offer disclosure even while
-- a credit-life product is active. The approval guard refused that record
-- whenever any active product existed; it now refuses it only above the
-- threshold. Everything else in the function is unchanged from
-- 20261013090000_asset_finance_foundation.

CREATE OR REPLACE FUNCTION public."guardLoanApplicationCreditLifeOffer"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_product_id TEXT;
  entering_approved_state BOOLEAN;
BEGIN
  -- Credit life (Reg. 2017) attaches to NCA credit agreements only.
  IF NEW."ncaRegime" = 'NON_NCA' THEN
    RETURN NEW;
  END IF;
  entering_approved_state :=
    NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND (
      TG_OP = 'INSERT'
      OR OLD."status"::TEXT NOT IN ('APPROVED', 'DISBURSED')
      OR (
        OLD."status"::TEXT <> 'DISBURSED'
        AND NEW."status"::TEXT = 'DISBURSED'
      )
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeProductName"
        IS DISTINCT FROM OLD."creditLifeProductName"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeInsurerName"
        IS DISTINCT FROM OLD."creditLifeInsurerName"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."creditLifeDisclosureVersion"
        IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
      OR NEW."creditLifeDisclosureSha256"
        IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
      OR NEW."creditLifeDisclosureAcknowledgedAt"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      OR NEW."creditLifeDisclosureAcknowledgedBy"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
    );

  IF NOT entering_approved_state THEN
    RETURN NEW;
  END IF;

  -- No offer was disclosed, so there is no product row to lock. But the row
  -- ASSERTS that no cover was offered, and that has to still be true at
  -- approval: if an insurer was onboarded between PASQ generation and here,
  -- the assertion is now false and the application must go back to draft for
  -- a current election. The offered path re-verifies at approval and again at
  -- disbursement; without this the no-offer path verified at neither.
  IF NEW."creditLifeDisclosureVersion" = 'credit-life-no-offer-v1' THEN
    -- Cover cannot be added at or below the R1,000 credit-life threshold
    -- (CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS, lib/insurance/credit-life-election.ts),
    -- so an active product is no offer there and "none was offered" stays
    -- true. The larger of the applied and approved amounts decides, so an
    -- approval above the threshold is still refused.
    IF GREATEST(NEW."appliedAmount", COALESCE(NEW."approvedAmount", 0)) > 100000 AND EXISTS (
      SELECT 1
      FROM "InsuranceProduct" AS product
      JOIN "Insurer" AS insurer
        ON insurer."id" = product."insurerId"
        AND insurer."tenantId" = product."tenantId"
      WHERE product."tenantId" = NEW."tenantId"
        AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
        AND product."active" = TRUE
        AND LENGTH(BTRIM(product."name")) > 0
        AND insurer."active" = TRUE
        AND LENGTH(BTRIM(insurer."name")) > 0
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Approval requires a current credit-life election: cover became available after this application recorded that none was offered';
    END IF;
    RETURN NEW;
  END IF;

  SELECT product."id"
  INTO locked_product_id
  FROM "InsuranceProduct" AS product
  JOIN "Insurer" AS insurer
    ON insurer."id" = product."insurerId"
    AND insurer."tenantId" = product."tenantId"
  WHERE product."id" = NEW."creditLifeProductId"
    AND product."tenantId" = NEW."tenantId"
    AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND product."active" = TRUE
    AND product."name" = NEW."creditLifeProductName"
    AND insurer."id" = NEW."creditLifeInsurerId"
    AND insurer."tenantId" = NEW."tenantId"
    AND insurer."active" = TRUE
    AND insurer."name" = NEW."creditLifeInsurerName"
  FOR SHARE OF product, insurer;

  IF locked_product_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires an active tenant-bound credit-life product and insurer matching the acknowledged PASQ';
  END IF;

  RETURN NEW;
END;
$function$;
