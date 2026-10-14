-- Keep the database's approval-evidence verifier byte-for-byte aligned with
-- bureauDecisionFingerprint(). The application appends `true` to the check
-- tuple only for an explicitly simulated provider result; older and genuine
-- bureau evidence therefore keeps its existing fingerprint.
CREATE OR REPLACE FUNCTION public."bureauDecisionSha256"(p_evidence jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  check_payload JSONB;
  override_payload JSONB;
  canonical JSONB;
BEGIN
  IF p_evidence = 'null'::JSONB THEN
    RETURN ENCODE(SHA256(CONVERT_TO('null', 'UTF8')), 'hex');
  END IF;
  IF JSONB_TYPEOF(p_evidence) <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'policy') <> 'object'
  THEN
    RETURN NULL;
  END IF;

  check_payload := CASE
    WHEN p_evidence -> 'check' = 'null'::JSONB THEN 'null'::JSONB
    WHEN JSONB_TYPEOF(p_evidence -> 'check') = 'object'
      THEN JSONB_BUILD_ARRAY(
        p_evidence #> '{check,id}',
        p_evidence #> '{check,clientId}',
        p_evidence #> '{check,subjectFingerprint}',
        p_evidence #> '{check,provider}',
        p_evidence #> '{check,createdAt}',
        p_evidence #> '{check,score}',
        p_evidence #> '{check,riskGrade}',
        p_evidence #> '{check,unscoreable}',
        p_evidence #> '{check,hasAdverse}',
        p_evidence #> '{check,deceased}',
        p_evidence #> '{check,underDebtReview}',
        p_evidence #> '{check,hasJudgement}',
        p_evidence #> '{check,hasNotice}',
        p_evidence #> '{check,obligationsCents}'
      )
    ELSE NULL
  END;
  IF check_payload IS NOT NULL
    AND p_evidence #> '{check,simulated}' = 'true'::JSONB
  THEN
    check_payload := check_payload || JSONB_BUILD_ARRAY(TRUE);
  END IF;
  override_payload := CASE
    WHEN p_evidence -> 'override' = 'null'::JSONB THEN 'null'::JSONB
    WHEN JSONB_TYPEOF(p_evidence -> 'override') = 'object'
      THEN JSONB_BUILD_ARRAY(
        p_evidence #> '{override,reason}',
        p_evidence #> '{override,reasonSha256}',
        p_evidence #> '{override,byId}',
        p_evidence #> '{override,at}'
      )
    ELSE NULL
  END;
  IF check_payload IS NULL OR override_payload IS NULL THEN
    RETURN NULL;
  END IF;

  canonical := JSONB_BUILD_ARRAY(
    p_evidence -> 'mode',
    check_payload,
    JSONB_BUILD_ARRAY(
      p_evidence #> '{policy,minimumScore}',
      p_evidence #> '{policy,blockAdverse}'
    ),
    override_payload
  );
  RETURN "jsonArraySha256"(canonical);
END;
$function$;
