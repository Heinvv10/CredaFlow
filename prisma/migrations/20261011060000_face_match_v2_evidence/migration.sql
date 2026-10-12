-- Selfie face match v2 (fix/selfie-face-match).
--
-- ENFORCEMENT-ADDING: ship together with the code that writes
-- provider "vlm-face-match-v2" (lib/kyc/selfie-biometric.server.ts). Applied
-- ahead of that code, every new biometric pass is refused, because the old
-- writer still stamps "vlm-face-match-v1".
--
-- 1. subject_has_composite_kyc: biometric evidence counts only when it is the
--    v2 verdict with every judgement consistent with a pass and both raw
--    confidences within 0.7..1, compared against the client's newest verified
--    ID copy (idDocumentId and idDocumentSha256). Booleans and the face count
--    compare as JSON values. The VLM-unavailable marker no longer exempts
--    evidence from that verdict (no writer produces a pass on it). Mirrors
--    assessBiometricEvidence in lib/kyc/biometric-evidence.ts.
-- 2. subject_has_manual_kyc_exception: recognise the two new failure reasons
--    (id_document_portrait_invalid, selfie_not_real_photograph) and keep them
--    OFF the exceptionable list, mirroring
--    MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS in
--    lib/kyc/manual-exception-policy.ts.
--    subject_has_in_person_kyc_verification: closed over an ID copy while any
--    selfie attempt was refused as id_document_portrait_invalid against it,
--    mirroring lib/kyc/in-person-verification.ts.
-- 3. Snapshot the clients VERIFIED before any evidence changes.
-- 4. Un-verify every live SELFIE row whose verified biometric evidence lacks
--    the v2 verdict. Left verified=true with biometricVerifiedAt set, it is a
--    "live biometric candidate" to subject_has_in_person_kyc_verification and
--    would close the in-person route for good. Mirrors
--    lib/kyc/identity-revocation.ts; the evidence JSON is kept unchanged.
-- 5. Demote every client still VERIFIED on evidence the new rules refuse
--    (v1/untagged selfie evidence, or a match not bound to the verified ID).
--    Client_enforce_composite_kyc re-checks subject_has_composite_kyc on
--    every Client write, so such a row would otherwise reject every later
--    update. Mirrors revoke_client_composite_kyc: PENDING, provenance
--    cleared, one KYC_STATUS_CHANGED audit row each from this migration.
--
-- The function bodies are the baseline definitions with only the marked
-- lines changed or added. Every changed line is strictly narrower than the
-- one it replaces except the face count, which deliberately also accepts
-- 1.0 and 1e0 (TS parity). Order matters: the functions are replaced before steps 4
-- and 5 read them, and step 4 runs before step 5, all within this
-- migration's single transaction.

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
          -- Booleans and the face count compare as JSON values, as
          -- assessBiometricEvidence reads them: the string "true" and "1" no
          -- longer pass. The booleans are strictly narrower than the baseline
          -- text comparisons they replace; the face count is not: 1.0 and 1e0
          -- now count as one face, a deliberate widening to match the TS gate
          -- (which reads them as the number 1). quality keeps lower(trim());
          -- trim() strips spaces only, and the TS parser now does the same.
          AND (
            selfie."extractionResult" -> 'vlmUnavailable' = 'true'::jsonb
            OR (
              selfie."extractionResult" #> '{faceDetected,value}' = 'true'::jsonb
              AND CASE
                WHEN jsonb_typeof(selfie."extractionResult" #> '{facesCount,value}') = 'number'
                THEN (selfie."extractionResult" #>> '{facesCount,value}')::numeric = 1
                ELSE false
              END
              AND selfie."extractionResult" #> '{isLive,value}' = 'true'::jsonb
              AND lower(
                trim(selfie."extractionResult" #>> '{quality,value}')
              ) IN ('good', 'poor')
            )
          )
          AND jsonb_typeof(selfie."biometricResult") = 'object'
          AND selfie."biometricResult" -> 'ok' = 'true'::jsonb
          AND selfie."biometricResult" -> 'verified' = 'true'::jsonb
          -- The VLM is the only provider, so evidence verifies only as the
          -- v2 verdict with every separate judgement agreeing with the pass
          -- (assessBiometricEvidence mirrors this). v1 carried one faceMatch
          -- boolean that once passed a selfie against a silhouette
          -- placeholder; its evidence no longer counts. The VLM-unavailable
          -- marker above stands in for the extraction checks only; it does
          -- not exempt this provider result. Booleans compare as jsonb so the
          -- string "true" does not pass.
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
          -- Absent or exactly false, as assessBiometricEvidence requires.
          AND (
            selfie."biometricResult" -> 'simulated' IS NULL
            OR selfie."biometricResult" -> 'simulated' = 'false'::jsonb
          )
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
          -- The selfie was compared against the ID copy the KYC rests on: the
          -- newest verified one, chosen exactly as
          -- subject_has_in_person_kyc_verification chooses it. A match
          -- against a newer unverified (even rejected) upload, or one since
          -- replaced, proves nothing about the verified identity. jsonb
          -- equality, so only strings equal to the row's values pass.
          AND EXISTS (
            SELECT 1
            FROM (
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
            WHERE id_document."contentSha256" ~ '^[a-f0-9]{64}$'
              AND selfie."biometricResult" -> 'idDocumentId' =
                to_jsonb(id_document."id")
              AND selfie."biometricResult" -> 'idDocumentSha256' =
                to_jsonb(id_document."contentSha256")
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
            )
          )
      )
      -- Added by 20261011060000_face_match_v2_evidence: while ANY selfie
      -- attempt (deleted or not, latest or not) was refused because THIS ID
      -- copy has no real photograph, no one may attest a face against it; a
      -- later attempt with another outcome does not reopen it. A refusal is
      -- about another copy only when it names a different idDocumentId or
      -- idDocumentSha256 as a string; one naming no copy closes every copy
      -- (fail closed). Only a different ID copy becoming the attested one
      -- reopens the route. Mirrors idDocumentPortraitRefused in
      -- lib/kyc/in-person-verification.ts.
      AND NOT EXISTS (
        SELECT 1
        FROM "ClientDocument" AS refused
        WHERE refused."tenantId" = p_tenant_id
          AND refused."clientId" = p_client_id
          AND refused."docType" = 'SELFIE'
          AND refused."biometricResult" ->> 'biometricFailureReason' =
            'id_document_portrait_invalid'
          AND NOT coalesce(
            (
              jsonb_typeof(refused."biometricResult" -> 'idDocumentId') = 'string'
              AND refused."biometricResult" ->> 'idDocumentId' <> id_document."id"
            )
            OR (
              jsonb_typeof(refused."biometricResult" -> 'idDocumentSha256') = 'string'
              AND refused."biometricResult" ->> 'idDocumentSha256' <> id_document."contentSha256"
            ),
            false
          )
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

-- 3. Snapshot the clients VERIFIED before any evidence changes, so step 5 can
-- audit every one this migration demotes, including those the composite-KYC
-- revoke trigger demotes during step 4. A session temp table, dropped below.
CREATE TEMP TABLE face_match_v2_verified_before AS
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
WHERE client."kycStatus" = 'VERIFIED';

-- 4. Un-verify selfie rows whose verified evidence lacks the v2 verdict (the
-- biometricResult lines step 1 added to subject_has_composite_kyc). Runs BEFORE
-- the demotion: un-verified, such a row stops being a live biometric
-- candidate, so a client with a valid in-person attestation and an old v1
-- selfie keeps its VERIFIED status instead of being demoted on a composite
-- that only failed because the v1 row still blocked the attestation.
-- ClientDocument_revoke_stale_composite_kyc fires on each row and demotes any
-- client whose composite now fails (its own audit row, reason
-- composite_kyc_evidence_changed); step 5 adds this migration's row for it. A
-- row without the v2 verdict cannot be a passing selfie, and a manual
-- exception needs a failed latest selfie, so only the in-person route can
-- change, and only towards open. No ClientDocument guard refuses this write:
-- they freeze only rows bound to an application as agreement, PASQ or
-- debit-mandate evidence, or typed EXECUTED_CREDIT_AGREEMENT / DEBIT_MANDATE,
-- and the attempt-sequence trigger fires only on tenant/client/type/sequence
-- changes.
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
    'migration', '20261011060000_face_match_v2_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM unverified;

-- 5. Demote clients the replaced rules no longer verify. The UPDATE sets a
-- non-VERIFIED status, so Client_enforce_composite_kyc does not re-check the
-- composite for these rows. One audit row for every client VERIFIED before
-- this migration and not after it, whether demoted here or by the revoke
-- trigger in step 4. No personal data in the audit payload. The audit id is
-- deterministic per client and has no ON CONFLICT: a clash aborts the
-- migration rather than demoting a client without its audit row.
WITH demoted AS (
  UPDATE "Client" AS client
  SET
    "kycStatus" = 'PENDING',
    "kycVerifiedAt" = NULL,
    "kycVerifiedById" = NULL,
    "kycVerificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE client."kycStatus" = 'VERIFIED'
    AND NOT "subject_has_composite_kyc"(
      client."tenantId",
      client."id",
      client."idNumber",
      client."firstName",
      client."lastName",
      client."dateOfBirth"
    )
  RETURNING client."id"
)
INSERT INTO "AuditLog" (
  "id", "tenantId", "userEmail", "action", "entity", "entityId",
  "oldValue", "newValue", "createdAt"
)
SELECT
  'kyc-face-match-v2-reset-' || before."id",
  before."tenantId",
  'migration@face-match-v2-evidence',
  'KYC_STATUS_CHANGED',
  'Client',
  before."id",
  before.previous_kyc,
  jsonb_build_object(
    'kycStatus', 'PENDING',
    'kycVerifiedAt', NULL,
    'kycVerifiedById', NULL,
    'kycVerificationMethod', NULL,
    'reason', 'face_match_v2_evidence_required',
    'migration', '20261011060000_face_match_v2_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM face_match_v2_verified_before AS before
-- The statement's own snapshot still shows the clients `demoted` updates as
-- VERIFIED; those the trigger demoted in step 4 already read PENDING.
JOIN "Client" AS client ON client."id" = before."id"
WHERE before."id" IN (SELECT demoted."id" FROM demoted)
  OR client."kycStatus" <> 'VERIFIED';

DROP TABLE face_match_v2_verified_before;
