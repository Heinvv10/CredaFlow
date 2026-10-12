-- Selfie face match v3 (feat/face-comparison-model).
--
-- ENFORCEMENT-ADDING: ship together with the code that writes provider
-- "vlm-face-match-v3" (lib/kyc/selfie-biometric.server.ts). Applied ahead of
-- that code, every new biometric pass is refused, because the old writer
-- still stamps "vlm-face-match-v2".
--
-- The same-person decision moves from the VLM to a face model (YuNet +
-- SFace, lib/kyc/face-model/). The VLM's gates all stay; its own "same" can
-- only refuse.
--
-- 1. face_model_evidence_holds: the stored face-model result re-proves a pass
--    (pinned model names and SHA-256s, exactly one selfie face, one dominant
--    ID face, similarity >= the pinned 0.363). Mirrors
--    faceModelEvidenceRefusal in lib/kyc/face-model/evidence.ts.
-- 2. subject_has_composite_kyc: the v2 body with only the provider tag
--    changed to v3 and the face-model check added. Every v2 condition is
--    kept (lib/kyc/face-match-v3-migration.test.ts compares them).
--    subject_has_manual_kyc_exception is NOT redefined: v3 adds no failure
--    reason (the face model's refusals reuse existing ones), so its v2 body
--    is still exact.
-- 3. Demote every client still VERIFIED on evidence the new rule refuses
--    (v2 or older selfie evidence), exactly as the v2 migration did for v1:
--    PENDING, provenance cleared, one KYC_STATUS_CHANGED audit row each.
-- 4. Un-verify every live SELFIE row whose verified biometric evidence lacks
--    the v3 verdict, exactly as the v2 migration did; the evidence JSON is
--    kept unchanged.
--
-- Order matters: the functions are replaced before step 3 reads them, all
-- within this migration's single transaction.

CREATE OR REPLACE FUNCTION public.face_model_evidence_holds(p_evidence jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- CASE guards every cast, since AND does not fix evaluation order and a
  -- string would raise instead of refuse. An absent key reads as NULL, which
  -- coalesce turns into a refusal.
  SELECT coalesce(
    jsonb_typeof(p_evidence) = 'object'
    AND p_evidence ->> 'detector' = 'face_detection_yunet_2023mar'
    AND p_evidence ->> 'detectorSha256' = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
    AND p_evidence ->> 'recognizer' = 'face_recognition_sface_2021dec'
    AND p_evidence ->> 'recognizerSha256' = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'
    AND p_evidence -> 'selfieFaceCount' = '1'::jsonb
    AND p_evidence -> 'threshold' = '0.363'::jsonb
    AND p_evidence -> 'samePerson' = 'true'::jsonb
    AND CASE
      WHEN jsonb_typeof(p_evidence -> 'similarity') = 'number'
      THEN (p_evidence ->> 'similarity')::numeric BETWEEN 0.363 AND 1
      ELSE false
    END
    -- One ID face with no ratio, or several where every other face's box is
    -- at most half the compared face's (the smart ID card's ghost portrait).
    AND CASE
      WHEN jsonb_typeof(p_evidence -> 'idFaceCount') IS DISTINCT FROM 'number' THEN false
      WHEN (p_evidence ->> 'idFaceCount')::numeric = 1
      THEN p_evidence -> 'idSecondFaceAreaRatio' = 'null'::jsonb
      WHEN (p_evidence ->> 'idFaceCount')::numeric > 1
        AND (p_evidence ->> 'idFaceCount')::numeric = trunc((p_evidence ->> 'idFaceCount')::numeric)
      THEN CASE
        WHEN jsonb_typeof(p_evidence -> 'idSecondFaceAreaRatio') = 'number'
        THEN (p_evidence ->> 'idSecondFaceAreaRatio')::numeric BETWEEN 0 AND 0.5
        ELSE false
      END
      ELSE false
    END,
    false
  );
$function$;

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
          -- Evidence verifies only as the v3 verdict: every VLM judgement
          -- agreeing with the pass AND the face model's comparison
          -- (assessBiometricEvidence mirrors this). v1 carried one faceMatch
          -- boolean that once passed a selfie against a silhouette
          -- placeholder, and v2 let the VLM decide same-person; neither
          -- counts, and the VLM-unavailable marker exempts nothing. Booleans
          -- compare as jsonb so the string "true" does not pass.
          AND selfie."biometricResult" ->> 'provider' = 'vlm-face-match-v3'
          AND "face_model_evidence_holds"(selfie."biometricResult" -> 'faceModel')
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
  'kyc-face-match-v3-reset-' || demoted."id",
  demoted."tenantId",
  'migration@face-match-v3-evidence',
  'KYC_STATUS_CHANGED',
  'Client',
  demoted."id",
  demoted.previous_kyc,
  jsonb_build_object(
    'kycStatus', 'PENDING',
    'kycVerifiedAt', NULL,
    'kycVerifiedById', NULL,
    'kycVerificationMethod', NULL,
    'reason', 'face_match_v3_evidence_required',
    'migration', '20261011080000_face_match_v3_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM demoted;

-- 4. Un-verify selfie rows whose verified evidence lacks the v3 verdict (the
-- biometricResult lines step 2 changed in subject_has_composite_kyc). Runs after
-- step 3, so ClientDocument_revoke_stale_composite_kyc finds demoted clients
-- already PENDING, and a client still VERIFIED keeps its composite: a row
-- without the v3 verdict cannot be its passing selfie, a manual exception
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
      selfie."biometricResult" ->> 'provider' = 'vlm-face-match-v3'
      AND "face_model_evidence_holds"(selfie."biometricResult" -> 'faceModel')
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
    "verificationNote" = 'Selfie evidence predates face match v3; repeat biometric or in-person verification.'
  FROM stale_selfie
  WHERE selfie."id" = stale_selfie."id"
  RETURNING selfie."id", selfie."tenantId", stale_selfie.previous_document
)
INSERT INTO "AuditLog" (
  "id", "tenantId", "userEmail", "action", "entity", "entityId",
  "oldValue", "newValue", "createdAt"
)
SELECT
  'kyc-face-match-v3-selfie-reset-' || unverified."id",
  unverified."tenantId",
  'migration@face-match-v3-evidence',
  'KYC_REJECTED',
  'ClientDocument',
  unverified."id",
  unverified.previous_document,
  jsonb_build_object(
    'verified', false,
    'verifiedAt', NULL,
    'verifiedById', NULL,
    'biometricVerifiedAt', NULL,
    'reason', 'face_match_v3_evidence_required',
    'migration', '20261011080000_face_match_v3_evidence',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM unverified;
