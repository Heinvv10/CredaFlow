-- Selfie face match v2 (fix/selfie-face-match).
--
-- ENFORCEMENT-ADDING: ship together with the code that writes
-- provider "vlm-face-match-v2" (lib/kyc/selfie-biometric.server.ts). Applied
-- ahead of that code, every new biometric pass is refused, because the old
-- writer still stamps "vlm-face-match-v1".
--
-- 1. subject_has_composite_kyc: biometric evidence counts only when it is the
--    v2 verdict with every judgement consistent with a pass and both raw
--    confidences within 0.7..1. The VLM-unavailable marker no longer
--    exempts evidence from that verdict (no writer produces a pass on it).
--    Mirrors assessBiometricEvidence in lib/kyc/biometric-evidence.ts.
-- 2. subject_has_manual_kyc_exception: recognise the two new failure reasons
--    (id_document_portrait_invalid, selfie_not_real_photograph) and keep them
--    OFF the exceptionable list, mirroring
--    MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS in
--    lib/kyc/manual-exception-policy.ts.
-- 3. Demote every client still VERIFIED on evidence the new rule refuses
--    (v1/untagged selfie evidence). Client_enforce_composite_kyc re-checks
--    subject_has_composite_kyc on every Client write, so such a row would
--    otherwise reject every later update. Mirrors revoke_client_composite_kyc:
--    PENDING, provenance cleared, one KYC_STATUS_CHANGED audit row each.
-- 4. Un-verify every live SELFIE row whose verified biometric evidence lacks
--    the v2 verdict. Left verified=true with biometricVerifiedAt set, it is a
--    "live biometric candidate" to subject_has_in_person_kyc_verification and
--    would close the in-person route for good. Mirrors
--    lib/kyc/identity-revocation.ts; the evidence JSON is kept unchanged.
--
-- Both function bodies are the baseline definitions with only the marked
-- lines added. Order matters: the functions are replaced before step 3 reads
-- them, all within this migration's single transaction.

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
          -- The VLM is the only provider, so evidence verifies only as the
          -- v2 verdict with every separate judgement agreeing with the pass
          -- (assessBiometricEvidence mirrors this). v1 carried one faceMatch
          -- boolean that once passed a selfie against a silhouette
          -- placeholder; its evidence no longer counts, and the
          -- VLM-unavailable marker exempts nothing. Booleans compare as
          -- jsonb so the string "true" does not pass.
          AND selfie."biometricResult" ->> 'provider' = 'vlm-face-match-v2'
          AND selfie."biometricResult" ->> 'idPhotoKind' = 'photograph'
          AND selfie."biometricResult" -> 'idPhotoIsRealPhotograph' = 'true'::jsonb
          AND selfie."biometricResult" -> 'idPhotoFaceDetected' = 'true'::jsonb
          AND selfie."biometricResult" -> 'selfieIsRealPhotograph' = 'true'::jsonb
          AND selfie."biometricResult" ->> 'samePerson' = 'same'
          AND selfie."biometricResult" -> 'faceMatch' = 'true'::jsonb
          -- The raw 0-1 confidences, not only the rounded scores: 0.695
          -- rounds to a passing 70, and anything above 1 is not a confidence.
          -- CASE guards the cast, since AND does not fix evaluation order and
          -- a string would raise instead of refuse.
          AND CASE
            WHEN jsonb_typeof(selfie."biometricResult" -> 'matchConfidence') = 'number'
            THEN (selfie."biometricResult" ->> 'matchConfidence')::numeric BETWEEN 0.7 AND 1
            ELSE false
          END
          AND CASE
            WHEN jsonb_typeof(selfie."biometricResult" -> 'livenessConfidence') = 'number'
            THEN (selfie."biometricResult" ->> 'livenessConfidence')::numeric BETWEEN 0.7 AND 1
            ELSE false
          END
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

-- 3. Demote clients the replaced rule no longer verifies. The UPDATE sets a
-- non-VERIFIED status, so Client_enforce_composite_kyc does not re-check the
-- composite for these rows. No personal data in the audit payload. The audit
-- id is deterministic per client and has no ON CONFLICT: a clash aborts the
-- migration rather than demoting a client without its audit row.
WITH stale AS (
  SELECT
    client."id",
    client."tenantId",
    jsonb_build_object(
      'kycStatus', client."kycStatus"::text,
      'kycVerifiedAt', client."kycVerifiedAt",
      'kycVerifiedById', client."kycVerifiedById",
      'kycVerificationMethod', client."kycVerificationMethod"::text
    ) AS previous_kyc
  FROM "Client" AS client
  WHERE client."kycStatus" = 'VERIFIED'
    AND NOT "subject_has_composite_kyc"(
      client."tenantId",
      client."id",
      client."idNumber",
      client."firstName",
      client."lastName",
      client."dateOfBirth"
    )
  FOR UPDATE
),
demoted AS (
  UPDATE "Client" AS client
  SET
    "kycStatus" = 'PENDING',
    "kycVerifiedAt" = NULL,
    "kycVerifiedById" = NULL,
    "kycVerificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM stale
  WHERE client."id" = stale."id"
    AND client."tenantId" = stale."tenantId"
  RETURNING client."id", client."tenantId", stale.previous_kyc
)
INSERT INTO "AuditLog" (
  "id", "tenantId", "userEmail", "action", "entity", "entityId",
  "oldValue", "newValue", "createdAt"
)
SELECT
  'kyc-face-match-v2-reset-' || demoted."id",
  demoted."tenantId",
  'migration@face-match-v2-evidence',
  'KYC_STATUS_CHANGED',
  'Client',
  demoted."id",
  demoted.previous_kyc,
  jsonb_build_object(
    'kycStatus', 'PENDING',
    'kycVerifiedAt', NULL,
    'kycVerifiedById', NULL,
    'kycVerificationMethod', NULL,
    'reason', 'face_match_v2_evidence_required',
    'migration', '20261010150000_face_match_v2_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM demoted;

-- 4. Un-verify selfie rows whose verified evidence lacks the v2 verdict (the
-- biometricResult lines step 1 added to subject_has_composite_kyc). Runs after
-- step 3, so ClientDocument_revoke_stale_composite_kyc finds demoted clients
-- already PENDING, and a client still VERIFIED keeps its composite: a row
-- without the v2 verdict cannot be its passing selfie, a manual exception
-- needs a failed latest selfie, and fewer live candidates only open the
-- in-person route. No ClientDocument guard refuses this write: they freeze
-- only rows bound to an application as agreement, PASQ or debit-mandate
-- evidence, or typed EXECUTED_CREDIT_AGREEMENT / DEBIT_MANDATE, and the
-- attempt-sequence trigger fires only on tenant/client/type/sequence changes.
WITH stale_selfie AS (
  SELECT
    selfie."id",
    selfie."tenantId",
    jsonb_build_object(
      'verified', selfie."verified",
      'verifiedAt', selfie."verifiedAt",
      'verifiedById', selfie."verifiedById",
      'biometricVerifiedAt', selfie."biometricVerifiedAt",
      'verificationNote', selfie."verificationNote"
    ) AS previous_document
  FROM "ClientDocument" AS selfie
  WHERE selfie."docType" = 'SELFIE'
    AND selfie."deletedAt" IS NULL
    AND selfie."verified" = true
    AND selfie."biometricVerifiedAt" IS NOT NULL
    AND NOT coalesce(
      selfie."biometricResult" ->> 'provider' = 'vlm-face-match-v2'
      AND selfie."biometricResult" ->> 'idPhotoKind' = 'photograph'
      AND selfie."biometricResult" -> 'idPhotoIsRealPhotograph' = 'true'::jsonb
      AND selfie."biometricResult" -> 'idPhotoFaceDetected' = 'true'::jsonb
      AND selfie."biometricResult" -> 'selfieIsRealPhotograph' = 'true'::jsonb
      AND selfie."biometricResult" ->> 'samePerson' = 'same'
      AND selfie."biometricResult" -> 'faceMatch' = 'true'::jsonb
      AND CASE
        WHEN jsonb_typeof(selfie."biometricResult" -> 'matchConfidence') = 'number'
        THEN (selfie."biometricResult" ->> 'matchConfidence')::numeric BETWEEN 0.7 AND 1
        ELSE false
      END
      AND CASE
        WHEN jsonb_typeof(selfie."biometricResult" -> 'livenessConfidence') = 'number'
        THEN (selfie."biometricResult" ->> 'livenessConfidence')::numeric BETWEEN 0.7 AND 1
        ELSE false
      END,
      false
    )
  FOR UPDATE
),
unverified AS (
  UPDATE "ClientDocument" AS selfie
  SET
    "verified" = false,
    "verifiedAt" = NULL,
    "verifiedById" = NULL,
    "biometricVerifiedAt" = NULL,
    "verificationNote" = 'Selfie evidence predates face match v2; repeat biometric or in-person verification.'
  FROM stale_selfie
  WHERE selfie."id" = stale_selfie."id"
  RETURNING selfie."id", selfie."tenantId", stale_selfie.previous_document
)
INSERT INTO "AuditLog" (
  "id", "tenantId", "userEmail", "action", "entity", "entityId",
  "oldValue", "newValue", "createdAt"
)
SELECT
  'kyc-face-match-v2-selfie-reset-' || unverified."id",
  unverified."tenantId",
  'migration@face-match-v2-evidence',
  'KYC_REJECTED',
  'ClientDocument',
  unverified."id",
  unverified.previous_document,
  jsonb_build_object(
    'verified', false,
    'verifiedAt', NULL,
    'verifiedById', NULL,
    'biometricVerifiedAt', NULL,
    'reason', 'face_match_v2_evidence_required',
    'migration', '20261010150000_face_match_v2_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM unverified;
