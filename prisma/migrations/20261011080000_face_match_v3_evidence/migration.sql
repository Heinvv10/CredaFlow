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
-- 2. subject_has_composite_kyc: the v2 body (20261011060000) with only the
--    provider tag changed to v3 and the face-model check added. Every other
--    v2 condition, including the binding to the newest verified ID copy, is
--    kept (lib/kyc/face-match-v3-migration.test.ts compares them).
--    subject_has_manual_kyc_exception and
--    subject_has_in_person_kyc_verification are NOT redefined: v3 adds no
--    failure reason (the face model's refusals reuse existing ones) and
--    neither reads the provider tag, so their v2 bodies are still exact.
-- 3-5. The v2 migration's data steps, applied to v2 (and older) evidence:
--    snapshot the clients VERIFIED, un-verify every live SELFIE row whose
--    verified evidence lacks the v3 verdict, then demote every client still
--    VERIFIED on evidence the new rule refuses, with one audit row each for
--    every client demoted here or by the revoke trigger during step 4. The
--    evidence JSON is kept unchanged.
--
-- Order matters: the functions are replaced before steps 4 and 5 read them,
-- and step 4 runs before step 5, all within this migration's single
-- transaction.

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
          -- Booleans and the face count compare as JSON values, as
          -- assessBiometricEvidence reads them: the string "true" and "1" no
          -- longer pass, and 1.0 counts as one face. Each is strictly
          -- narrower than the baseline text comparison it replaces. quality
          -- keeps lower(trim()); trim() strips spaces only, and the TS parser
          -- now does exactly the same.
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
          -- Evidence verifies only as the v3 verdict: every VLM judgement
          -- agreeing with the pass AND the face model's comparison
          -- (assessBiometricEvidence mirrors this). v1 carried one faceMatch
          -- boolean that once passed a selfie against a silhouette
          -- placeholder, and v2 let the VLM decide same-person; neither
          -- counts. The VLM-unavailable marker above stands in for the
          -- extraction checks only; it does not exempt this provider result.
          -- Booleans compare as jsonb so the string "true" does not pass.
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

-- 3. Snapshot the clients VERIFIED before any evidence changes, so step 5 can
-- audit every one this migration demotes, including those the composite-KYC
-- revoke trigger demotes during step 4. A session temp table, dropped below.
CREATE TEMP TABLE face_match_v3_verified_before AS
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

-- 4. Un-verify selfie rows whose verified evidence lacks the v3 verdict (the
-- biometricResult lines step 2 changed in subject_has_composite_kyc). Runs BEFORE
-- the demotion: un-verified, such a row stops being a live biometric
-- candidate, so a client with a valid in-person attestation and an old v2
-- selfie keeps its VERIFIED status instead of being demoted on a composite
-- that only failed because the v2 row still blocked the attestation.
-- ClientDocument_revoke_stale_composite_kyc fires on each row and demotes any
-- client whose composite now fails (its own audit row, reason
-- composite_kyc_evidence_changed); step 5 adds this migration's row for it. A
-- row without the v3 verdict cannot be a passing selfie, and a manual
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
  'kyc-face-match-v3-reset-' || before."id",
  before."tenantId",
  'migration@face-match-v3-evidence',
  'KYC_STATUS_CHANGED',
  'Client',
  before."id",
  before.previous_kyc,
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
FROM face_match_v3_verified_before AS before
-- The statement's own snapshot still shows the clients `demoted` updates as
-- VERIFIED; those the trigger demoted in step 4 already read PENDING.
JOIN "Client" AS client ON client."id" = before."id"
WHERE before."id" IN (SELECT demoted."id" FROM demoted)
  OR client."kycStatus" <> 'VERIFIED';

DROP TABLE face_match_v3_verified_before;
