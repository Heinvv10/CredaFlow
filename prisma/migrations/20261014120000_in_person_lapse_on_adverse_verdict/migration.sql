-- In-person attestation lapses on a later adverse face verdict.
--
-- ENFORCEMENT-ADDING: ship together with the code that stamps
-- biometricResult.verdictRecordedAt (lib/kyc/selfie-biometric.server.ts) and
-- derives the same rules in TypeScript (lib/kyc/in-person-verification.ts).
--
-- This migration REJECTS writes that main still makes. Applied ahead of this
-- code, or to a database holding the state below, it is not backward
-- compatible:
--  * main already records biometric_outcome_not_recorded when a judge answered
--    but recording the outcome failed (runBiometricVerification's catch path).
--    A client VERIFIED in person with such an attempt created after the
--    attestation fails the new predicate, and Client_enforce_composite_kyc
--    then raises on EVERY unrelated write to that client, not only on KYC
--    writes. Step 3 below demotes those clients (with an audit row each) so
--    none is left unwritable.
--  * Code from before this change does not stamp verdictRecordedAt, so a
--    verdict it records after an attestation does not lapse it. The stamp is
--    what the lapse rule reads; the old writer is merely not covered.
--
-- 1. face_verdict_is_adverse: a stored result carries an adverse same-person
--    answer from either judge. Mirrors adverseFaceVerdict in
--    lib/kyc/biometric-evidence.ts (present, not JSON null, and not the
--    passing answer).
-- 2. subject_has_in_person_kyc_verification: the v2 body
--    (20261011060000_face_match_v2_evidence) with two NOT EXISTS added, one
--    for an adverse verdict recorded after the attestation, one for an
--    unknown-outcome attempt submitted after it (failed unrecorded, swept, or
--    deleted while pending/processing). The ID-portrait refusal NOT EXISTS is
--    WIDENED to also read biometricResult.workerFailureReason, the reason the
--    worker itself gave, which the ID/subject binding keeps when it replaces
--    the recorded reason with subject_identity_changed. Every other v2
--    condition is kept (lib/kyc/in-person-lapse-migration.test.ts compares
--    them and pins the one reworded line).
-- 3. Data step: every client still VERIFIED that no longer satisfies
--    client_has_composite_kyc is demoted by revoke_client_composite_kyc, which
--    writes the KYC_STATUS_CHANGED audit row, and the count is RAISEd as a
--    NOTICE. It is deliberately NOT narrowed to clients with an in-person
--    attestation: any VERIFIED client failing the composite predicate is
--    already in violation, and Client_enforce_composite_kyc would raise on
--    every write to it. The predicate that changed here is the in-person one,
--    so the clients caught are those whose in-person attestation the new rules
--    refuse (an unknown-outcome attempt after it). A client already failing
--    for another reason would be caught too: none can exist on a database the
--    triggers have protected, and demoting one is the safe outcome.

CREATE OR REPLACE FUNCTION public.face_verdict_is_adverse(p_result jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- jsonb -> on a non-object yields NULL, as jsonRecord() yields null. A key
  -- that is absent is NULL, one set to JSON null is 'null'::jsonb; both read
  -- as "no answer", exactly as `value !== undefined && value !== null`.
  SELECT coalesce(
    (p_result -> 'samePerson' IS NOT NULL AND p_result -> 'samePerson' <> 'null'::jsonb AND p_result -> 'samePerson' <> '"same"'::jsonb)
    OR (p_result -> 'faceMatch' IS NOT NULL AND p_result -> 'faceMatch' <> 'null'::jsonb AND p_result -> 'faceMatch' <> 'true'::jsonb)
    OR (p_result #> '{faceModel,samePerson}' IS NOT NULL AND p_result #> '{faceModel,samePerson}' <> 'null'::jsonb AND p_result #> '{faceModel,samePerson}' <> 'true'::jsonb)
    OR (p_result #> '{faceVerdict,samePerson}' IS NOT NULL AND p_result #> '{faceVerdict,samePerson}' <> 'null'::jsonb AND p_result #> '{faceVerdict,samePerson}' <> '"same"'::jsonb)
    OR (p_result #> '{faceVerdict,faceMatch}' IS NOT NULL AND p_result #> '{faceVerdict,faceMatch}' <> 'null'::jsonb AND p_result #> '{faceVerdict,faceMatch}' <> 'true'::jsonb)
    OR (p_result #> '{faceVerdict,faceModelSamePerson}' IS NOT NULL AND p_result #> '{faceVerdict,faceModelSamePerson}' <> 'null'::jsonb AND p_result #> '{faceVerdict,faceModelSamePerson}' <> 'true'::jsonb),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.subject_has_in_person_kyc_verification(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT
        record."id",
        record."completedAt",
        record."data"
      FROM "ComplianceRecord" AS record
      WHERE record."tenantId" = p_tenant_id
        AND record."type" = 'KYC_EXCEPTION'
        AND record."referenceId" = p_client_id
        AND record."status" = 'COMPLETED'
        AND record."completedAt" IS NOT NULL
      ORDER BY
        record."completedAt" DESC,
        record."createdAt" DESC,
        record."id" DESC
      LIMIT 1
    ) AS attestation
    CROSS JOIN LATERAL (
      SELECT
        id_document."id",
        id_document."contentSha256"
      FROM "ClientDocument" AS id_document
      WHERE id_document."tenantId" = p_tenant_id
        AND id_document."clientId" = p_client_id
        AND id_document."docType" = 'ID_COPY'
        AND id_document."deletedAt" IS NULL
        AND id_document."verified" = true
      ORDER BY
        id_document."createdAt" DESC,
        id_document."id" DESC
      LIMIT 1
    ) AS id_document
    WHERE NOT EXISTS (
        -- Only a selfie that is a LIVE biometric candidate takes the human
        -- fallback out of scope: an attempt still processing, or one whose
        -- provider-verified evidence passed. A failed or soft-deleted attempt
        -- must NOT permanently close the in-person route (2026-07-28
        -- remediation, report S3 F) - the previous "any selfie row at all"
        -- rule stranded clients whose one failed attempt removed every path
        -- to payout-grade KYC.
        SELECT 1
        FROM "ClientDocument" AS selfie
        WHERE selfie."tenantId" = p_tenant_id
          AND selfie."clientId" = p_client_id
          AND selfie."docType" = 'SELFIE'
          AND selfie."deletedAt" IS NULL
          AND (
            selfie."extractionStatus" = 'processing'
            OR (
              selfie."verified" = true
              AND selfie."biometricVerifiedAt" IS NOT NULL
              -- Added by 20261011060000_face_match_v2_evidence: a passed
              -- selfie stops blocking once the ID copy it names is no longer
              -- a non-deleted, unrejected ID copy of this client (staff
              -- rejected or deleted it, or it is gone). It no longer counts
              -- as biometric evidence, and blocking the human route over it
              -- stranded the client. One that names no copy still blocks.
              -- The release holds only for an attestation completed AFTER the
              -- selfie was captured: otherwise deleting or rejecting a
              -- doctored copy revived an attestation recorded before the
              -- episode. Mirrors selfieBlocksInPersonVerification in
              -- lib/kyc/in-person-verification.ts.
              AND (
                jsonb_typeof(selfie."biometricResult" -> 'idDocumentId') IS DISTINCT FROM 'string'
                OR attestation."completedAt" <= selfie."createdAt"
                OR EXISTS (
                  SELECT 1
                  FROM "ClientDocument" AS named_copy
                  WHERE named_copy."tenantId" = p_tenant_id
                    AND named_copy."clientId" = p_client_id
                    AND named_copy."docType" = 'ID_COPY'
                    AND named_copy."deletedAt" IS NULL
                    AND named_copy."verificationRejectedAt" IS NULL
                    AND named_copy."verificationRejectedById" IS NULL
                    AND named_copy."id" = selfie."biometricResult" ->> 'idDocumentId'
                )
              )
            )
          )
      )
      -- Added by 20261011060000_face_match_v2_evidence: while ANY selfie
      -- attempt (deleted or not, latest or not) was refused because THIS ID
      -- copy has no real photograph, no one may attest a face against it; a
      -- later attempt with another outcome does not reopen it. A refusal
      -- closes it when it names this copy's id, OR this copy's bytes (the same
      -- image re-uploaded as a new row is the same photo-less ID), OR no copy
      -- at all (neither field a string; fail closed). Only a copy with
      -- different bytes, under a different row, reopens the route. Mirrors
      -- idDocumentPortraitRefused in lib/kyc/in-person-verification.ts.
      AND NOT EXISTS (
        SELECT 1
        FROM "ClientDocument" AS refused
        WHERE refused."tenantId" = p_tenant_id
          AND refused."clientId" = p_client_id
          AND refused."docType" = 'SELFIE'
          AND 'id_document_portrait_invalid' IN (
            refused."biometricResult" ->> 'biometricFailureReason',
            refused."biometricResult" ->> 'workerFailureReason'
          )
          AND (
            (
              jsonb_typeof(refused."biometricResult" -> 'idDocumentId') IS DISTINCT FROM 'string'
              AND jsonb_typeof(refused."biometricResult" -> 'idDocumentSha256') IS DISTINCT FROM 'string'
            )
            OR (
              jsonb_typeof(refused."biometricResult" -> 'idDocumentId') = 'string'
              AND refused."biometricResult" ->> 'idDocumentId' = id_document."id"
            )
            OR (
              jsonb_typeof(refused."biometricResult" -> 'idDocumentSha256') = 'string'
              AND refused."biometricResult" ->> 'idDocumentSha256' = id_document."contentSha256"
            )
          )
      )
      -- Added by 20261014120000_in_person_lapse_on_adverse_verdict: an adverse
      -- face verdict recorded AFTER the attestation was completed lapses it.
      -- Staff attested without seeing that verdict, so the client must be
      -- re-verified (a new attestation completed after the verdict, or a
      -- selfie that passes). ANY attempt counts (deleted or not, latest or
      -- not), so a benign-failing retake cannot bury the verdict; it counts
      -- only when it names the ID copy the attestation is bound to: a stale
      -- answer about a superseded ID copy has no effect (a verdict naming no
      -- ID copy at all counts: fail closed, as the portrait refusal above
      -- does). A verdict recorded strictly BEFORE the attestation (staff could
      -- see it) leaves the attestation standing, as before; one in the SAME
      -- millisecond cannot be ordered and counts as after. Attempts are those of
      -- PRIOR_FAILED_ATTEMPT_CONDITIONS (lib/kyc/biometric-evidence.ts).
      -- The recorded-at stamp is written by persistBiometricOutcome
      -- (biometricResult.verdictRecordedAt); rows without one are never
      -- "after". Compared as fixed-format ISO text under the C collation so
      -- no locale can reorder it. Mirrors adverseVerdictRecordedAfter in
      -- lib/kyc/in-person-verification.ts.
      AND NOT EXISTS (
        SELECT 1
        FROM "ClientDocument" AS verdict
        WHERE verdict."tenantId" = p_tenant_id
          AND verdict."clientId" = p_client_id
          AND verdict."docType" = 'SELFIE'
          AND (
            verdict."extractionStatus" IN ('failed', 'skipped', 'pending', 'processing')
            OR verdict."verificationRejectedAt" IS NOT NULL
            OR verdict."verificationRejectedById" IS NOT NULL
          )
          AND jsonb_typeof(verdict."biometricResult" -> 'verdictRecordedAt') = 'string'
          AND verdict."biometricResult" ->> 'verdictRecordedAt'
            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          AND (verdict."biometricResult" ->> 'verdictRecordedAt') COLLATE "C" >=
            to_char(attestation."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') COLLATE "C"
          AND (
            jsonb_typeof(verdict."biometricResult" -> 'idDocumentId') IS DISTINCT FROM 'string'
            OR verdict."biometricResult" ->> 'idDocumentId' = id_document."id"
          )
          AND "face_verdict_is_adverse"(verdict."biometricResult")
      )
      -- Added by 20261014120000_in_person_lapse_on_adverse_verdict: a selfie
      -- attempt submitted AFTER the attestation whose outcome is unknown lapses
      -- it too. Unknown means any of: it ended biometric_outcome_not_recorded
      -- (the worker died, or its verdict could not be recorded); the sweeper
      -- failed it (biometricResult.sweptAt, which stays when a late worker
      -- answer replaces the reason); or it was deleted while still pending or
      -- processing, which no writer touches again. The lost verdict could have
      -- been a mismatch, so this fails closed. ANY such attempt counts,
      -- deleted or not, latest or not, over the same attempts as above; one
      -- created in the same millisecond as the attestation counts as after, as
      -- the v2 release rule above does (completedAt <= createdAt). Mirrors
      -- unknownOutcomeAfterAttestation in lib/kyc/in-person-verification.ts.
      AND NOT EXISTS (
        SELECT 1
        FROM "ClientDocument" AS unknown_outcome
        WHERE unknown_outcome."tenantId" = p_tenant_id
          AND unknown_outcome."clientId" = p_client_id
          AND unknown_outcome."docType" = 'SELFIE'
          AND (
            unknown_outcome."extractionStatus" IN ('failed', 'skipped', 'pending', 'processing')
            OR unknown_outcome."verificationRejectedAt" IS NOT NULL
            OR unknown_outcome."verificationRejectedById" IS NOT NULL
          )
          AND (
            unknown_outcome."biometricResult" ->> 'biometricFailureReason' =
              'biometric_outcome_not_recorded'
            OR jsonb_typeof(unknown_outcome."biometricResult" -> 'sweptAt') = 'string'
            -- Deleted while still pending/processing: neither the sweeper nor
            -- the worker writes a deleted row, so it never gets a reason.
            OR (
              unknown_outcome."deletedAt" IS NOT NULL
              AND unknown_outcome."extractionStatus" IN ('pending', 'processing')
            )
          )
          AND unknown_outcome."createdAt" >= attestation."completedAt"
      )
      AND id_document."contentSha256" ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(attestation."data") = 'object'
      AND attestation."data" ->> 'kind' = 'KYC_IN_PERSON_VERIFICATION'
      AND attestation."data" ->> 'version' = 'kyc-in-person-verification-v1'
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'clientId'
      ) = p_client_id
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'idDocumentId'
      ) = id_document."id"
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'idDocumentSha256'
      ) = id_document."contentSha256"
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'subjectFingerprint'
      ) = "biometric_subject_fingerprint"(
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      AND attestation."data" ->> 'method' IN (
        'IN_PERSON_BRANCH',
        'KNOWN_EXISTING_CLIENT',
        'AGENT_VERIFIED'
      )
      AND length(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'note'
        )
      ) >= 20
      AND nullif(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'approvedById'
        ),
        ''
      ) IS NOT NULL
      AND nullif(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'approvedByEmail'
        ),
        ''
      ) IS NOT NULL
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'approvedAt'
      ) = to_char(
        -- Prisma stores DateTime as TIMESTAMP(3) without time zone. Formatting
        -- that value directly is session-time-zone invariant; AT TIME ZONE
        -- would convert it to timestamptz and shift it in non-UTC sessions.
        attestation."completedAt",
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
  );
$function$;

-- 3. Demote every client VERIFIED on an attestation the new predicate refuses.
DO $$
DECLARE
  demoted integer;
BEGIN
  SELECT count(*) INTO demoted
  FROM "Client" AS client
  WHERE client."kycStatus" = 'VERIFIED'
    AND NOT "client_has_composite_kyc"(client."tenantId", client."id");

  PERFORM "revoke_client_composite_kyc"(
    client."tenantId",
    client."id",
    '20261014120000_in_person_lapse_on_adverse_verdict',
    'SELFIE',
    'MIGRATION'
  )
  FROM "Client" AS client
  WHERE client."kycStatus" = 'VERIFIED'
    AND NOT "client_has_composite_kyc"(client."tenantId", client."id");

  RAISE NOTICE '20261014120000_in_person_lapse_on_adverse_verdict: % client(s) demoted from VERIFIED', demoted;
END
$$;
