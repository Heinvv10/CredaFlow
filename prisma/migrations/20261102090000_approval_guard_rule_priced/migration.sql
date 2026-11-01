-- guardSignedDebitMandateAuthority compared an approval's rate and fee with the LoanProduct row, so a pricing rule (lib/product-engine),
-- which prices away from that row, was refused in both regimes and decide answered 500. A rate or fee off the row now stands only as
-- what a rule gives: unretired, in its window today, of this tenant, for this product or every product, on the row's own base rate, the
-- rate being the rule's SET value or the base plus its ADD value, the fee the rule's. On an NCA application the rate must also sit under
-- the Regulation 42 ceiling (ncaRatePmAllowed), as lib/loan/nca-interest-cap.ts computes it from the latest approved repo rate; the
-- lower unapproved feed value and the repeat short-term rate stay in code. An approval with no rule is judged as before.
CREATE OR REPLACE FUNCTION public."ncaRatePmAllowed"(tenant_id TEXT, principal_cents INTEGER, term_days INTEGER, rate_pm DOUBLE PRECISION, interest_model TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT CASE
    WHEN principal_cents <= 800000 AND term_days <= 180 THEN rate_pm <= 0.05 + 1e-9
    ELSE COALESCE(rate_pm * (CASE WHEN interest_model = 'REDUCING_BALANCE' THEN 12 ELSE 365.0 / 30 END) * 100 <= (
      SELECT (reference."rate"::DOUBLE PRECISION + 0.21) * 100 + 1e-9 FROM "ReferenceRate" AS reference
      WHERE reference."tenantId" = tenant_id AND reference."basis" = 'REPO' AND reference."status" = 'APPROVED'
        AND reference."effectiveDate" <= (now() AT TIME ZONE 'Africa/Johannesburg')::DATE
      ORDER BY reference."effectiveDate" DESC LIMIT 1
    ), FALSE)
  END
$function$;

DO $body$
DECLARE definition TEXT; changed TEXT;
  rule_of TEXT := $sql$EXISTS (SELECT 1 FROM "ProductPricingRule" AS rule
    WHERE rule."id" = new_approval #>> '{inputs,productVersion,pricingRuleId}' AND rule."tenantId" = NEW."tenantId"
      AND (rule."productId" IS NULL OR rule."productId" = product."id") AND rule."retiredAt" IS NULL
      AND rule."validFrom" <= (now() AT TIME ZONE 'Africa/Johannesburg')::DATE
      AND (rule."validTo" IS NULL OR rule."validTo" >= (now() AT TIME ZONE 'Africa/Johannesburg')::DATE)$sql$;
BEGIN
  SELECT pg_get_functiondef('public."guardSignedDebitMandateAuthority"()'::regprocedure) INTO definition;
  changed := replace(definition,
    $sql$AND new_approval #>> '{inputs,interestRatePm}'
              = TO_JSONB(product."interestRatePm")::TEXT$sql$,
    $sql$AND (new_approval #>> '{inputs,interestRatePm}' = TO_JSONB(product."interestRatePm")::TEXT OR (
              new_approval #>> '{inputs,productVersion,baseRatePm}' = TO_JSONB(product."interestRatePm")::TEXT
              AND (NEW."disclosureRegime" = 'KEY_FACTS' OR NEW."ncaRegime" IS NOT DISTINCT FROM 'NON_NCA' OR "ncaRatePmAllowed"(NEW."tenantId", NEW."approvedAmount", NEW."approvedTermDays",
                (new_approval #>> '{inputs,interestRatePm}')::DOUBLE PRECISION, new_approval #>> '{inputs,interestModel}'))
              AND $sql$ || rule_of || $sql$
                AND ABS((new_approval #>> '{inputs,interestRatePm}')::DOUBLE PRECISION - CASE rule."rateMode" WHEN 'SET' THEN rule."rateValue" ELSE GREATEST(0, product."interestRatePm" + rule."rateValue") END) < 1e-9)))$sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardSignedDebitMandateAuthority rate shape changed'; END IF;
  definition := changed;
  changed := replace(definition,
    $sql$AND new_approval #>> '{inputs,initiationFeePct}'
              = TO_JSONB(product."initiationFeePct")::TEXT$sql$,
    $sql$AND (new_approval #>> '{inputs,initiationFeePct}' = TO_JSONB(product."initiationFeePct")::TEXT OR $sql$ || rule_of || $sql$
                AND new_approval #>> '{inputs,initiationFeePct}' = TO_JSONB(rule."initiationFeePct")::TEXT))$sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardSignedDebitMandateAuthority fee shape changed'; END IF;
  EXECUTE changed;
END;
$body$;
