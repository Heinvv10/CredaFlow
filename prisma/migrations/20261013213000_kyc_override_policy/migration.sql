-- Per-lender KYC override policy and dual-approval ledger. This migration adds
-- enforcement and must ship with the application code that satisfies it.
CREATE TYPE "KycOverrideKind" AS ENUM ('EXCEPTION', 'IN_PERSON');
CREATE TYPE "KycOverrideRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED');

ALTER TABLE "TenantConfig"
  ADD COLUMN "kycOverrideEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "kycOverrideMinRole" "UserRole" NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN "kycOverrideSecondApprover" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_kycOverrideMinRole_check"
  CHECK ("kycOverrideMinRole" IN ('BRANCH_MANAGER', 'ADMIN'));

CREATE UNIQUE INDEX "ClientDocument_tenantId_id_key" ON "ClientDocument"("tenantId", "id");

CREATE TABLE "KycOverrideRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "selfieDocumentId" TEXT,
  "kind" "KycOverrideKind" NOT NULL,
  "payload" JSONB NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedWithTotp" BOOLEAN NOT NULL DEFAULT false,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "KycOverrideRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KycOverrideRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KycOverrideRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "KycOverrideRequest_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "KycOverrideRequest_tenantId_selfieDocumentId_fkey" FOREIGN KEY ("tenantId", "selfieDocumentId") REFERENCES "ClientDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "KycOverrideRequest_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "KycOverrideRequest_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "KycOverrideRequest_tenantId_id_key" ON "KycOverrideRequest"("tenantId", "id");
CREATE INDEX "KycOverrideRequest_tenantId_clientId_status_expiresAt_idx" ON "KycOverrideRequest"("tenantId", "clientId", "status", "expiresAt");
CREATE INDEX "KycOverrideRequest_tenantId_requestedById_idx" ON "KycOverrideRequest"("tenantId", "requestedById");
CREATE INDEX "KycOverrideRequest_tenantId_decidedById_idx" ON "KycOverrideRequest"("tenantId", "decidedById");

ALTER TABLE "KycOverrideRequest" ADD CONSTRAINT "KycOverrideRequest_different_decider_check" CHECK (
  "status" NOT IN ('APPROVED', 'DECLINED') OR "decidedById" <> "requestedById"
);
ALTER TABLE "KycOverrideRequest" ADD CONSTRAINT "KycOverrideRequest_decision_fields_check" CHECK (
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "decisionNote" IS NULL)
  OR
  ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND length(trim("decisionNote")) > 0)
);
ALTER TABLE "KycOverrideRequest" ADD CONSTRAINT "KycOverrideRequest_expiry_check" CHECK (
  "expiresAt" = "requestedAt" + interval '7 days'
);
ALTER TABLE "KycOverrideRequest" ADD CONSTRAINT "KycOverrideRequest_selfie_kind_check" CHECK (
  ("kind" = 'EXCEPTION' AND "selfieDocumentId" IS NOT NULL)
  OR ("kind" = 'IN_PERSON' AND "selfieDocumentId" IS NULL)
);

CREATE OR REPLACE FUNCTION public.kyc_override_request_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT isfinite(NEW."requestedAt")
       OR NOT isfinite(NEW."expiresAt")
       OR NEW."requestedAt" > clock_timestamp() THEN
      RAISE EXCEPTION 'KYC override request timestamps must be finite and requestedAt cannot be in the future';
    END IF;
    IF NEW."status" <> 'PENDING'
       OR NEW."decidedById" IS NOT NULL
       OR NEW."decidedAt" IS NOT NULL
       OR NEW."decisionNote" IS NOT NULL THEN
      RAISE EXCEPTION 'KYC override requests must be inserted as PENDING';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KYC override requests cannot be deleted';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'decided KYC override requests are immutable';
  END IF;
  IF NEW."status" NOT IN ('APPROVED', 'DECLINED', 'EXPIRED') THEN
    RAISE EXCEPTION 'invalid KYC override request transition';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."clientId" <> OLD."clientId" OR NEW."kind" <> OLD."kind"
     OR NEW."payload" <> OLD."payload" OR NEW."requestedById" <> OLD."requestedById"
     OR NEW."requestedWithTotp" <> OLD."requestedWithTotp"
     OR NEW."requestedAt" <> OLD."requestedAt" OR NEW."expiresAt" <> OLD."expiresAt"
     OR NEW."selfieDocumentId" IS DISTINCT FROM OLD."selfieDocumentId" THEN
    RAISE EXCEPTION 'KYC override request evidence is immutable';
  END IF;
  IF NEW."status" = 'APPROVED' AND clock_timestamp() > OLD."expiresAt" THEN
    RAISE EXCEPTION 'expired KYC override request cannot be approved';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "KycOverrideRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "KycOverrideRequest"
FOR EACH ROW EXECUTE FUNCTION kyc_override_request_guard();

CREATE OR REPLACE FUNCTION public.guard_kyc_override_request_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  policy_enabled boolean := true;
  policy_min_role "UserRole" := 'ADMIN';
  policy_second_approver boolean := false;
  policy_require_totp boolean := true;
  requester_role "UserRole";
  requester_active boolean;
  requester_totp_enabled boolean;
  requester_totp_counter integer;
BEGIN
  SELECT config."kycOverrideEnabled", config."kycOverrideMinRole",
         config."kycOverrideSecondApprover", config."requireStaffTotp"
    INTO policy_enabled, policy_min_role, policy_second_approver, policy_require_totp
  FROM "TenantConfig" AS config
  WHERE config."tenantId" = NEW."tenantId";
  IF NOT FOUND THEN
    policy_enabled := true;
    policy_min_role := 'ADMIN';
    policy_second_approver := false;
    policy_require_totp := true;
  END IF;
  IF NOT policy_enabled OR NOT policy_second_approver THEN
    RAISE EXCEPTION 'KYC override requests are not enabled by lender policy';
  END IF;

  SELECT actor."role", actor."active", actor."totpEnabled", actor."lastTotpCounter"
    INTO requester_role, requester_active, requester_totp_enabled, requester_totp_counter
  FROM "User" AS actor
  WHERE actor."tenantId" = NEW."tenantId" AND actor."id" = NEW."requestedById";
  IF requester_role IS NULL OR NOT requester_active
     OR (policy_min_role = 'ADMIN' AND requester_role NOT IN ('ADMIN', 'SUPER_ADMIN'))
     OR (policy_min_role = 'BRANCH_MANAGER' AND requester_role NOT IN ('BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'KYC override requester is not an active eligible senior';
  END IF;
  IF policy_require_totp AND (
    NOT NEW."requestedWithTotp" OR NOT requester_totp_enabled OR requester_totp_counter IS NULL
  ) THEN
    RAISE EXCEPTION 'KYC override request requires durable TOTP provenance';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "KycOverrideRequest_guard_policy"
BEFORE INSERT ON "KycOverrideRequest"
FOR EACH ROW EXECUTE FUNCTION guard_kyc_override_request_policy();

-- Product safety constant. 0.30 is deliberately fixed and currently
-- unmeasured: no real impostor-pair dataset exists. It mirrors
-- FACE_MISMATCH_FLOOR in lib/kyc/face-model/models.ts.
CREATE OR REPLACE FUNCTION public.kyc_exception_selfie_is_clear_mismatch(
  p_tenant_id text,
  p_client_id text,
  p_exception_data jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "ClientDocument" AS selfie
    WHERE selfie."tenantId" = p_tenant_id
      AND selfie."clientId" = p_client_id
      AND selfie."id" = p_exception_data ->> 'documentId'
      AND selfie."docType" = 'SELFIE'
      AND (
        selfie."biometricResult" #>> '{faceVerdict,samePerson}' = 'different'
        OR CASE
          WHEN jsonb_typeof(selfie."biometricResult" #> '{faceModel,similarity}') = 'number'
          THEN (selfie."biometricResult" #>> '{faceModel,similarity}')::numeric < 0.30
          ELSE coalesce(selfie."biometricResult" ->> 'biometricFailureReason', '') IN (
            'match_score_below_threshold', 'provider_verification_failed'
          ) OR selfie."biometricResult" -> 'faceVerdict' IS NOT NULL
        END
      )
  );
$function$;

-- Do not silently leave a cached VERIFIED client payout-eligible when the new
-- projection would reject their current clear-mismatch exception. A lender
-- must review and reconcile any such rows under the rollout confirmation gate
-- before this enforcement migration may proceed.
DO $preflight$
DECLARE
  affected_count integer;
BEGIN
  SELECT count(*) INTO affected_count
  FROM "Client" AS client
  CROSS JOIN LATERAL (
    SELECT record."data"
    FROM "ComplianceRecord" AS record
    WHERE record."tenantId" = client."tenantId"
      AND record."referenceId" = client."id"
      AND record."type" = 'KYC_EXCEPTION'
      AND record."status" = 'COMPLETED'
      AND record."completedAt" IS NOT NULL
    ORDER BY record."completedAt" DESC, record."createdAt" DESC, record."id" DESC
    LIMIT 1
  ) AS current_exception
  WHERE client."kycStatus" = 'VERIFIED'
    AND current_exception."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
    AND EXISTS (
      SELECT 1
      FROM "ClientDocument" AS selfie
      WHERE selfie."tenantId" = client."tenantId"
        AND selfie."clientId" = client."id"
        AND selfie."id" = current_exception."data" ->> 'documentId'
        AND selfie."docType" = 'SELFIE'
        AND (
          selfie."biometricResult" #>> '{faceVerdict,samePerson}' = 'different'
          OR CASE
            WHEN jsonb_typeof(selfie."biometricResult" #> '{faceModel,similarity}') = 'number'
            THEN (selfie."biometricResult" #>> '{faceModel,similarity}')::numeric < 0.30
            ELSE coalesce(selfie."biometricResult" ->> 'biometricFailureReason', '') IN (
              'match_score_below_threshold', 'provider_verification_failed'
            ) OR selfie."biometricResult" -> 'faceVerdict' IS NOT NULL
          END
        )
    );

  IF affected_count > 0 THEN
    RAISE EXCEPTION
      'KYC override policy preflight found % VERIFIED client(s) with a current clear-mismatch exception; reconcile only after the rollout confirmation gate',
      affected_count;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_clear_mismatch_kyc_exception()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."type" = 'KYC_EXCEPTION'
     AND NEW."status" = 'COMPLETED'
     AND NEW."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
     AND "kyc_exception_selfie_is_clear_mismatch"(NEW."tenantId", NEW."referenceId", NEW."data") THEN
    RAISE EXCEPTION 'clear face mismatch cannot be overridden';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ComplianceRecord_guard_clear_mismatch_kyc_exception"
BEFORE INSERT OR UPDATE ON "ComplianceRecord"
FOR EACH ROW EXECUTE FUNCTION guard_clear_mismatch_kyc_exception();

CREATE UNIQUE INDEX "ComplianceRecord_one_grant_per_kyc_override_request"
ON "ComplianceRecord"("tenantId", (("data" ->> 'overrideRequestId')))
WHERE "type" = 'KYC_EXCEPTION'
  AND "status" = 'COMPLETED'
  AND "data" ->> 'kind' IN ('KYC_MANUAL_EXCEPTION', 'KYC_IN_PERSON_VERIFICATION')
  AND nullif("data" ->> 'overrideRequestId', '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_approved_kyc_override_has_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'APPROVED' AND NOT EXISTS (
    SELECT 1
    FROM "ComplianceRecord" AS record
    WHERE record."tenantId" = NEW."tenantId"
      AND record."referenceId" = NEW."clientId"
      AND record."type" = 'KYC_EXCEPTION'
      AND record."status" = 'COMPLETED'
      AND record."data" ->> 'overrideRequestId' = NEW."id"
      AND record."data" ->> 'approvedById' = NEW."decidedById"
      AND (
        (NEW."kind" = 'EXCEPTION'
          AND record."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
          AND record."data" ->> 'documentId' = NEW."selfieDocumentId"
          AND record."data" ->> 'reason' = NEW."payload" ->> 'reason'
          AND record."data" ->> 'supportingEvidence' = NEW."payload" ->> 'supportingEvidence')
        OR
        (NEW."kind" = 'IN_PERSON'
          AND record."data" ->> 'kind' = 'KYC_IN_PERSON_VERIFICATION'
          AND record."data" ->> 'method' = NEW."payload" ->> 'method'
          AND record."data" ->> 'note' = NEW."payload" ->> 'note')
      )
  ) THEN
    RAISE EXCEPTION 'approved KYC override request must grant matching evidence in the same transaction';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER "KycOverrideRequest_approved_requires_grant"
AFTER UPDATE ON "KycOverrideRequest"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_approved_kyc_override_has_grant();

-- Enforce the complete lender policy at the durable evidence boundary. The
-- trigger is deferred so the decision route can create the compliance record
-- and mark its request APPROVED in either order inside one transaction.
CREATE OR REPLACE FUNCTION public.guard_kyc_override_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  policy_enabled boolean := true;
  policy_min_role "UserRole" := 'ADMIN';
  policy_second_approver boolean := false;
  policy_require_totp boolean := true;
  approver_role "UserRole";
  approver_active boolean;
  approver_totp_enabled boolean;
  approver_totp_counter integer;
  request_matches boolean;
BEGIN
  IF NEW."type" <> 'KYC_EXCEPTION'
     OR NEW."status" <> 'COMPLETED'
     OR NEW."data" ->> 'kind' NOT IN ('KYC_MANUAL_EXCEPTION', 'KYC_IN_PERSON_VERIFICATION') THEN
    RETURN NEW;
  END IF;

  SELECT config."kycOverrideEnabled", config."kycOverrideMinRole",
         config."kycOverrideSecondApprover", config."requireStaffTotp"
    INTO policy_enabled, policy_min_role, policy_second_approver, policy_require_totp
  FROM "TenantConfig" AS config
  WHERE config."tenantId" = NEW."tenantId";

  IF NOT FOUND THEN
    policy_enabled := true;
    policy_min_role := 'ADMIN';
    policy_second_approver := false;
    policy_require_totp := true;
  END IF;

  IF NOT policy_enabled THEN
    RAISE EXCEPTION 'KYC overrides are disabled for this lender';
  END IF;

  SELECT actor."role", actor."active", actor."totpEnabled", actor."lastTotpCounter"
    INTO approver_role, approver_active, approver_totp_enabled, approver_totp_counter
  FROM "User" AS actor
  WHERE actor."tenantId" = NEW."tenantId"
    AND actor."id" = NEW."data" ->> 'approvedById';

  IF approver_role IS NULL OR NOT approver_active
     OR (policy_min_role = 'ADMIN' AND approver_role NOT IN ('ADMIN', 'SUPER_ADMIN'))
     OR (policy_min_role = 'BRANCH_MANAGER' AND approver_role NOT IN ('BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'KYC override approver is below the lender minimum role';
  END IF;

  IF policy_require_totp AND (
     NEW."data" -> 'approvedWithTotp' IS DISTINCT FROM 'true'::jsonb
     OR NOT approver_totp_enabled OR approver_totp_counter IS NULL) THEN
    RAISE EXCEPTION 'KYC override requires a durable TOTP assertion';
  END IF;

  IF policy_second_approver THEN
    SELECT EXISTS (
      SELECT 1
      FROM "KycOverrideRequest" AS request
      WHERE request."tenantId" = NEW."tenantId"
        AND request."id" = NEW."data" ->> 'overrideRequestId'
        AND request."clientId" = NEW."referenceId"
        AND request."status" = 'APPROVED'
        AND request."decidedById" = NEW."data" ->> 'approvedById'
        AND request."requestedById" <> request."decidedById"
        AND (NOT policy_require_totp OR request."requestedWithTotp")
        AND EXISTS (
          SELECT 1 FROM "User" AS requester
          WHERE requester."tenantId" = NEW."tenantId"
            AND requester."id" = request."requestedById"
            AND requester."active"
            AND (
              (policy_min_role = 'ADMIN' AND requester."role" IN ('ADMIN', 'SUPER_ADMIN'))
              OR (policy_min_role = 'BRANCH_MANAGER' AND requester."role" IN ('BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN'))
            )
            AND (NOT policy_require_totp OR (requester."totpEnabled" AND requester."lastTotpCounter" IS NOT NULL))
        )
        AND (
          (NEW."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
            AND request."kind" = 'EXCEPTION'
            AND request."selfieDocumentId" = NEW."data" ->> 'documentId'
            AND request."payload" ->> 'reason' = NEW."data" ->> 'reason'
            AND request."payload" ->> 'supportingEvidence' = NEW."data" ->> 'supportingEvidence')
          OR
          (NEW."data" ->> 'kind' = 'KYC_IN_PERSON_VERIFICATION'
            AND request."kind" = 'IN_PERSON'
            AND request."selfieDocumentId" IS NULL
            AND request."payload" ->> 'method' = NEW."data" ->> 'method'
            AND request."payload" ->> 'note' = NEW."data" ->> 'note')
        )
    ) INTO request_matches;

    IF NOT request_matches THEN
      RAISE EXCEPTION 'KYC override requires a matching approved request';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER "ComplianceRecord_guard_kyc_override_policy"
AFTER INSERT OR UPDATE ON "ComplianceRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_kyc_override_policy();

CREATE OR REPLACE FUNCTION public.subject_has_manual_kyc_exception(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT record."id", record."completedAt", record."data"
      FROM "ComplianceRecord" AS record
      WHERE record."tenantId" = p_tenant_id
        AND record."type" = 'KYC_EXCEPTION'
        AND record."referenceId" = p_client_id
        AND record."status" = 'COMPLETED'
        AND record."completedAt" IS NOT NULL
      ORDER BY record."completedAt" DESC, record."createdAt" DESC, record."id" DESC
      LIMIT 1
    ) AS exception
    CROSS JOIN LATERAL (
      SELECT selfie."id", selfie."contentSha256", selfie."deletedAt", selfie."extractionStatus", selfie."biometricResult"
      FROM "ClientDocument" AS selfie
      WHERE selfie."tenantId" = p_tenant_id
        AND selfie."clientId" = p_client_id
        AND selfie."docType" = 'SELFIE'
      ORDER BY selfie."biometricAttemptSequence" DESC, selfie."createdAt" DESC, selfie."id" DESC
      LIMIT 1
    ) AS selfie
    WHERE selfie."deletedAt" IS NULL
      AND selfie."contentSha256" ~ '^[a-f0-9]{64}$'
      AND selfie."extractionStatus" IN ('failed', 'skipped')
      AND jsonb_typeof(exception."data") = 'object'
      AND exception."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
      AND exception."data" ->> 'version' = 'manual-kyc-exception-v1'
      AND NOT "kyc_exception_selfie_is_clear_mismatch"(p_tenant_id, p_client_id, exception."data")
      AND "trim_manual_kyc_exception_text"(exception."data" ->> 'clientId') = p_client_id
      AND "trim_manual_kyc_exception_text"(exception."data" ->> 'documentId') = selfie."id"
      AND "trim_manual_kyc_exception_text"(exception."data" ->> 'documentSha256') = selfie."contentSha256"
      AND "trim_manual_kyc_exception_text"(exception."data" ->> 'subjectFingerprint') = "biometric_subject_fingerprint"(
        p_client_id, p_id_number, p_first_name, p_last_name, p_date_of_birth
      )
      AND exception."data" ->> 'biometricFailureReason' = CASE
        WHEN selfie."biometricResult" ->> 'biometricFailureReason' IN (
          'extraction_incomplete', 'biometric_evidence_missing', 'document_deleted',
          'document_not_verified', 'superseded_biometric_evidence', 'subject_fingerprint_missing',
          'subject_identity_changed', 'face_not_detected', 'face_count_invalid',
          'vlm_liveness_failed', 'image_unusable', 'validation_mismatch',
          'match_score_below_threshold', 'liveness_score_below_threshold',
          'provider_verification_missing', 'simulated_provider_evidence',
          'provider_verification_failed', 'id_document_portrait_invalid',
          'selfie_not_real_photograph'
        ) THEN selfie."biometricResult" ->> 'biometricFailureReason'
        ELSE 'extraction_incomplete'
      END
      AND exception."data" ->> 'biometricFailureReason' IN (
        'face_not_detected', 'face_count_invalid', 'vlm_liveness_failed',
        'image_unusable', 'validation_mismatch', 'match_score_below_threshold',
        'liveness_score_below_threshold', 'provider_verification_failed'
      )
      AND length("trim_manual_kyc_exception_text"(exception."data" ->> 'reason')) >= 20
      AND length("trim_manual_kyc_exception_text"(exception."data" ->> 'supportingEvidence')) >= 20
      AND nullif("trim_manual_kyc_exception_text"(exception."data" ->> 'approvedById'), '') IS NOT NULL
      AND nullif("trim_manual_kyc_exception_text"(exception."data" ->> 'approvedByEmail'), '') IS NOT NULL
      AND "trim_manual_kyc_exception_text"(exception."data" ->> 'approvedAt') = to_char(
        exception."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
  );
$function$;
