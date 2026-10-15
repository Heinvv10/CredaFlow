-- A newer, unreviewed ID copy holds the client at PENDING.
--
-- ENFORCEMENT-ADDING: ship together with the code that derives the same rule
-- (lib/kyc/id-replacement.ts, deriveCompositeKycState). Applied ahead of that
-- code, the old writers that write VERIFIED for a client with such a pending
-- copy are refused by Client_enforce_composite_kyc.
--
-- Until now subject_has_composite_kyc kept honouring the older verified ID
-- copy while a newer one awaited review, so a client who uploaded a new ID
-- stayed VERIFIED on the old one. Hein decided that is not acceptable.
--
-- 1. subject_has_pending_id_replacement: the client's newest ID copy that no
--    reviewer refused (neither verificationRejectedAt nor
--    verificationRejectedById) is unverified while an older copy is verified.
--    Same ordering as every ID-copy selection: createdAt DESC, id DESC (code
--    units, as the TypeScript compares them).
-- 2. subject_has_composite_kyc: the v3 body (20261011080000) with ONE added
--    top-level conjunct, delimited by BEGIN/END comments so a later migration
--    that also redefines this function can fold it in
--    (lib/kyc/id-replacement-migration.test.ts compares the two bodies).
--    client_has_composite_kyc, Client_enforce_composite_kyc and the
--    ClientDocument revoke trigger all read this function, so the rule holds
--    for every writer without touching them: inserting the replacement ID_COPY
--    row itself demotes a VERIFIED client, with the trigger's audit row.
-- 3. Demote clients already VERIFIED with a pending replacement, one audit row
--    each, as the v2 and v3 migrations did for their rules.

CREATE OR REPLACE FUNCTION public.subject_has_pending_id_replacement(p_tenant_id text, p_client_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "ClientDocument" AS verified_copy
    WHERE verified_copy."tenantId" = p_tenant_id
      AND verified_copy."clientId" = p_client_id
      AND verified_copy."docType" = 'ID_COPY'
      AND verified_copy."deletedAt" IS NULL
      AND verified_copy."verified" = true
  )
  AND coalesce(
    (
      SELECT newest."verified" = false
      FROM (
        SELECT candidate."verified"
        FROM "ClientDocument" AS candidate
        WHERE candidate."tenantId" = p_tenant_id
          AND candidate."clientId" = p_client_id
          AND candidate."docType" = 'ID_COPY'
          AND candidate."deletedAt" IS NULL
          AND candidate."verificationRejectedAt" IS NULL
          AND candidate."verificationRejectedById" IS NULL
        ORDER BY candidate."createdAt" DESC, candidate."id" COLLATE "C" DESC
        LIMIT 1
      ) AS newest
    ),
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
    )
    -- BEGIN replacement-ID rule (20261014130000_replacement_id_pending_not_verified).
    -- The only change from the v3 body. A newer, unreviewed, non-refused ID
    -- copy outweighs the older verified one on every route (selfie, manual
    -- exception, in-person). Mirrors pendingIdReplacement in
    -- lib/kyc/id-replacement.ts. A later migration that redefines this
    -- function must carry this conjunct.
    AND NOT "subject_has_pending_id_replacement"(p_tenant_id, p_client_id)
    -- END replacement-ID rule
    ;
$function$;

-- 3. Demote clients VERIFIED on an ID copy a newer unreviewed one outweighs.
-- The UPDATE sets a non-VERIFIED status, so Client_enforce_composite_kyc does
-- not re-check the composite for these rows. The audit id is deterministic per
-- client and has no ON CONFLICT: a clash aborts the migration rather than
-- demoting a client without its audit row. No personal data in the payload.
WITH before AS (
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
    AND "subject_has_pending_id_replacement"(client."tenantId", client."id")
),
demoted AS (
  UPDATE "Client" AS client
  SET
    "kycStatus" = 'PENDING',
    "kycVerifiedAt" = NULL,
    "kycVerifiedById" = NULL,
    "kycVerificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM before
  WHERE client."id" = before."id"
  RETURNING client."id"
)
INSERT INTO "AuditLog" (
  "id", "tenantId", "userEmail", "action", "entity", "entityId",
  "oldValue", "newValue", "createdAt"
)
SELECT
  'kyc-replacement-id-reset-' || before."id",
  before."tenantId",
  'migration@replacement-id-pending',
  'KYC_STATUS_CHANGED',
  'Client',
  before."id",
  before.previous_kyc,
  jsonb_build_object(
    'kycStatus', 'PENDING',
    'kycVerifiedAt', NULL,
    'kycVerifiedById', NULL,
    'kycVerificationMethod', NULL,
    'reason', 'replacement_id_pending_review',
    'migration', '20261014130000_replacement_id_pending_not_verified',
    'databaseEnforced', true
  ),
  CURRENT_TIMESTAMP
FROM before
JOIN demoted ON demoted."id" = before."id";
