-- guardSignedDebitMandateAuthority compared an approval's rate and fee with the LoanProduct row, so a pricing rule (lib/product-engine),
-- which prices away from that row, was refused in both regimes and decide answered 500. A rate or fee that differs from the row now
-- stands when the approval names a rule of this tenant and product, on the row's own base rate. The rule's arithmetic is decide's locked
-- re-pricing (verifyLockedApprovalCandidate); a float recomputed here would not compare. An approval without a rule is judged as before.
DO $body$
DECLARE definition TEXT; changed TEXT;
  rule_of TEXT := 'EXISTS (SELECT 1 FROM "ProductPricingRule" AS rule WHERE rule."id" = new_approval #>> ''{inputs,productVersion,pricingRuleId}'''
    || ' AND rule."tenantId" = NEW."tenantId" AND rule."productId" = product."id"';
BEGIN
  SELECT pg_get_functiondef('public."guardSignedDebitMandateAuthority"()'::regprocedure) INTO definition;
  changed := replace(definition,
    'AND new_approval #>> ''{inputs,interestRatePm}''' || chr(10) || '              = TO_JSONB(product."interestRatePm")::TEXT',
    'AND (new_approval #>> ''{inputs,interestRatePm}'' = TO_JSONB(product."interestRatePm")::TEXT OR ('
      || 'new_approval #>> ''{inputs,productVersion,baseRatePm}'' = TO_JSONB(product."interestRatePm")::TEXT AND ' || rule_of || ')))');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardSignedDebitMandateAuthority rate shape changed'; END IF;
  definition := changed;
  changed := replace(definition,
    'AND new_approval #>> ''{inputs,initiationFeePct}''' || chr(10) || '              = TO_JSONB(product."initiationFeePct")::TEXT',
    'AND (new_approval #>> ''{inputs,initiationFeePct}'' = TO_JSONB(product."initiationFeePct")::TEXT OR '
      || rule_of || ' AND new_approval #>> ''{inputs,initiationFeePct}'' = TO_JSONB(rule."initiationFeePct")::TEXT))');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardSignedDebitMandateAuthority fee shape changed'; END IF;
  EXECUTE changed;
END;
$body$;
