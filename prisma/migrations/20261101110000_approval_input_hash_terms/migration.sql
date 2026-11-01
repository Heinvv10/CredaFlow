-- affordabilityInputSha256 must hash what affordabilityInputFingerprint (lib/affordability/snapshot.ts) hashes. The product engine added
-- `repayment` and `productVersion` to the JavaScript side only, so approvalEvidenceIsIntact refused every approval of a versioned product
-- ("Active approval evidence requires a validated approval transition"): decide answered 500 in both regimes, and the integration suite did
-- not see it because it installs approved rows with session_replication_role. This hashes the same strings, and `borrowerIdentity`, the
-- identity a key-facts approval freezes (lib/non-nca-documents/identity.ts). An approval with none of the three hashes exactly as before.
CREATE OR REPLACE FUNCTION public."affordabilityInputSha256"(p_inputs jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  canonical JSONB;
BEGIN
  IF JSONB_TYPEOF(p_inputs) <> 'object' THEN
    RETURN NULL;
  END IF;

  canonical := JSONB_BUILD_ARRAY(
    p_inputs -> 'monthlyIncomeCents',
    p_inputs -> 'monthlyExpensesCents',
    p_inputs -> 'applicationDebtCents',
    p_inputs -> 'clientDebtCents',
    p_inputs -> 'declaredDebtCents',
    p_inputs -> 'bureauObligationsCents',
    p_inputs -> 'proposedInstalmentCents',
    p_inputs -> 'principalCents',
    p_inputs -> 'termDays',
    p_inputs -> 'productId',
    p_inputs -> 'interestRatePm',
    p_inputs -> 'interestModel',
    p_inputs -> 'initiationFeePct',
    p_inputs -> 'initiationFeeMaxCents',
    p_inputs -> 'monthlyServiceFeeCents',
    p_inputs -> 'initiationFeePayment',
    p_inputs -> 'ndiBufferPct'
  );
  IF p_inputs ? 'creditLifePremiumCents' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      p_inputs -> 'creditLifePremiumCents'
    );
  END IF;
  IF p_inputs ? 'repayment' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'repayment:' || "jsonArrayText"(JSONB_BUILD_ARRAY(
        p_inputs #> '{repayment,frequency}',
        p_inputs #> '{repayment,structure}',
        p_inputs #> '{repayment,graceKind}',
        p_inputs #> '{repayment,graceInstalments}',
        p_inputs #> '{repayment,instalments}'
      ))
    );
  END IF;
  IF p_inputs ? 'borrowerIdentity' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'identity:' || (p_inputs ->> 'borrowerIdentity')
    );
  END IF;
  IF p_inputs ? 'productVersion' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'version:' || "jsonArrayText"(JSONB_BUILD_ARRAY(
        p_inputs #> '{productVersion,id}',
        p_inputs #> '{productVersion,version}',
        p_inputs #> '{productVersion,baseRatePm}',
        p_inputs #> '{productVersion,pricingRuleId}'
      ))
    );
  END IF;
  RETURN "jsonArraySha256"(canonical);
END;
$function$;
