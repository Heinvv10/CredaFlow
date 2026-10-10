-- Selfie face match v2 (fix/selfie-face-match).
--
-- ENFORCEMENT-ADDING: ship together with the code that writes
-- provider "vlm-face-match-v2" (lib/kyc/selfie-biometric.server.ts). Applied
-- ahead of that code, every new biometric pass is refused, because the old
-- writer still stamps "vlm-face-match-v1".
--
-- 1. subject_has_composite_kyc: VLM-produced biometric evidence counts only
--    when it is the v2 verdict with every judgement consistent with a pass.
--    The legacy VLM-unavailable (external provider) branch is unchanged.
--    Mirrors assessBiometricEvidence in lib/kyc/biometric-evidence.ts.
-- 2. subject_has_manual_kyc_exception: recognise the two new failure reasons
--    (id_document_portrait_invalid, selfie_not_real_photograph) and keep them
--    OFF the exceptionable list, mirroring
--    MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS in
--    lib/kyc/manual-exception-policy.ts.
--
-- Both bodies are the baseline definitions with only the marked lines added.

CREATE OR REPLACE FUNCTION public.subject_has_composite_kyc(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT
    (
      SELECT COUNT(DISTINCT document."docType") = 4
      FROM "ClientDocument" AS document
      WHERE document."tenantId" = p_tenant_id
        AND document."clientId" = p_client_id
        AND document."docType" IN (
          'ID_COPY', 'PROOF_OF_ADDRESS', 'PAYSLIP', 'BANK_STATEMENT'
        )
        AND document."deletedAt" IS NULL
        AND document."verified" = true
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "ClientDocument" AS selfie
        WHERE selfie."id" = (
          SELECT latest."id"
          FROM "ClientDocument" AS latest
          WHERE latest."tenantId" = p_tenant_id
            AND latest."clientId" = p_client_id
            AND latest."docType" = 'SELFIE'
          ORDER BY
            latest."biometricAttemptSequence" DESC,
            latest."createdAt" DESC,
            latest."id" DESC
          LIMIT 1
        )
          AND selfie."deletedAt" IS NULL
          AND selfie."verified" = true
          AND selfie."extractionStatus" = 'done'
          AND selfie."validationMismatch" = false
          AND selfie."validationScore" >= 70
          AND selfie."biometricMatchScore" >= 70
          AND selfie."biometricLiveness" >= 70
          AND selfie."biometricVerifiedAt" IS NOT NULL
          AND jsonb_typeof(selfie."extractionResult") = 'object'
          AND (
            selfie."extractionResult" ->> 'vlmUnavailable' = 'true'
            OR (
              selfie."extractionResult" #>> '{faceDetected,value}' = 'true'
              AND selfie."extractionResult" #>> '{facesCount,value}' = '1'
              AND selfie."extractionResult" #>> '{isLive,value}' = 'true'
              AND lower(
                trim(selfie."extractionResult" #>> '{quality,value}')
              ) IN ('good', 'poor')
            )
          )
          AND jsonb_typeof(selfie."biometricResult") = 'object'
          AND selfie."biometricResult" ->> 'ok' = 'true'
          AND selfie."biometricResult" ->> 'verified' = 'true'
          -- When the VLM ran it is the provider, so its evidence verifies
          -- only as the v2 verdict with every separate judgement agreeing
          -- with the pass (assessBiometricEvidence mirrors this). v1 carried
          -- one faceMatch boolean that once passed a selfie against a
          -- silhouette placeholder; its evidence no longer counts. Booleans
          -- compare as jsonb so the string "true" does not pass.
          AND (
            selfie."extractionResult" ->> 'vlmUnavailable' = 'true'
            OR (
              selfie."biometricResult" ->> 'provider' = 'vlm-face-match-v2'
              AND selfie."biometricResult" ->> 'idPhotoKind' = 'photograph'
              AND selfie."biometricResult" -> 'idPhotoIsRealPhotograph' = 'true'::jsonb
              AND selfie."biometricResult" -> 'idPhotoFaceDetected' = 'true'::jsonb
              AND selfie."biometricResult" -> 'selfieIsRealPhotograph' = 'true'::jsonb
              AND selfie."biometricResult" ->> 'samePerson' = 'same'
              AND selfie."biometricResult" -> 'faceMatch' = 'true'::jsonb
            )
          )
          AND coalesce(
            selfie."biometricResult" ->> 'simulated',
            'false'
          ) <> 'true'
          AND coalesce(
            selfie."biometricResult" ->> 'subjectFingerprint',
            ''
          ) ~ '^[a-f0-9]{64}$'
          AND selfie."biometricResult" ->> 'subjectFingerprint' =
            "biometric_subject_fingerprint"(
              p_client_id,
              p_id_number,
              p_first_name,
              p_last_name,
              p_date_of_birth
            )
          AND jsonb_typeof(
            selfie."biometricResult" -> 'matchScore'
          ) = 'number'
          AND jsonb_typeof(
            selfie."biometricResult" -> 'livenessScore'
          ) = 'number'
          AND (
            selfie."biometricResult" ->> 'matchScore'
          )::numeric >= 70
          AND (
            selfie."biometricResult" ->> 'livenessScore'
          )::numeric >= 70
      )
      OR "subject_has_manual_kyc_exception"(
        p_tenant_id,
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      OR "subject_has_in_person_kyc_verification"(
        p_tenant_id,
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.subject_has_manual_kyc_exception(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
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
    ) AS exception
    CROSS JOIN LATERAL (
      SELECT
        selfie."id",
        selfie."contentSha256",
        selfie."deletedAt",
        selfie."extractionStatus",
        selfie."biometricResult"
      FROM "ClientDocument" AS selfie
      WHERE selfie."tenantId" = p_tenant_id
        AND selfie."clientId" = p_client_id
        AND selfie."docType" = 'SELFIE'
      ORDER BY
        selfie."biometricAttemptSequence" DESC,
        selfie."createdAt" DESC,
        selfie."id" DESC
      LIMIT 1
    ) AS selfie
    WHERE selfie."deletedAt" IS NULL
      AND selfie."contentSha256" ~ '^[a-f0-9]{64}$'
      AND selfie."extractionStatus" IN ('failed', 'skipped')
      AND jsonb_typeof(exception."data") = 'object'
      AND exception."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
      AND exception."data" ->> 'version' = 'manual-kyc-exception-v1'
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'clientId'
      ) = p_client_id
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'documentId'
      ) = selfie."id"
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'documentSha256'
      ) = selfie."contentSha256"
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'subjectFingerprint'
      ) = "biometric_subject_fingerprint"(
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      AND exception."data" ->> 'biometricFailureReason' = CASE
        WHEN selfie."biometricResult" ->> 'biometricFailureReason' IN (
          'extraction_incomplete',
          'biometric_evidence_missing',
          'document_deleted',
          'document_not_verified',
          'superseded_biometric_evidence',
          'subject_fingerprint_missing',
          'subject_identity_changed',
          'face_not_detected',
          'face_count_invalid',
          'vlm_liveness_failed',
          'image_unusable',
          'validation_mismatch',
          'match_score_below_threshold',
          'liveness_score_below_threshold',
          'provider_verification_missing',
          'simulated_provider_evidence',
          'provider_verification_failed',
          -- Known reasons, deliberately absent from the allow-list below: an
          -- ID with no real photograph, or a selfie that is not a real one,
          -- leaves no face match for a senior to reason over.
          'id_document_portrait_invalid',
          'selfie_not_real_photograph'
        )
        THEN selfie."biometricResult" ->> 'biometricFailureReason'
        ELSE 'extraction_incomplete'
      END
      AND exception."data" ->> 'biometricFailureReason' IN (
        'face_not_detected',
        'face_count_invalid',
        'vlm_liveness_failed',
        'image_unusable',
        'validation_mismatch',
        'match_score_below_threshold',
        'liveness_score_below_threshold',
        'provider_verification_failed'
      )
      AND length(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'reason'
        )
      ) >= 20
      AND length(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'supportingEvidence'
        )
      ) >= 20
      AND nullif(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'approvedById'
        ),
        ''
      ) IS NOT NULL
      AND nullif(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'approvedByEmail'
        ),
        ''
      ) IS NOT NULL
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'approvedAt'
      ) = to_char(
        -- Prisma stores DateTime as TIMESTAMP(3) without time zone. Formatting
        -- that value directly is session-time-zone invariant; AT TIME ZONE
        -- would convert it to timestamptz and shift it in non-UTC sessions.
        exception."completedAt",
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
  );
$function$;
