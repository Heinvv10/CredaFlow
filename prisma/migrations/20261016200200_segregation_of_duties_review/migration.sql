-- Segregation of duties, review round 1 (PR #140).
--
-- * LoanApplication.disbursedById references a User of the same tenant, like
--   approvedById, and a disbursement names an active staff member who may
--   disburse (LOAN_ADMIN and above, the disburse route's own minimum).
-- * The guard also runs on INSERT: a consumer application cannot be inserted
--   already DISBURSED or countersigned in breach of the setting, and
--   disbursedById is never written on insert.
-- * A recorded consumer signature is frozen: once agreementSignedAt is set, its
--   method, witness, IP and artefact change only by clearing all of them
--   together (return to review / draft). Otherwise the in-branch witness could
--   be rewritten before the countersignature, defeating the
--   witness-is-not-the-countersigner rule.

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_disbursedById_fkey" FOREIGN KEY ("tenantId", "disbursedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public."guardLoanApplicationSegregationOfDuties"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  disbursing BOOLEAN;
  countersigning BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."disbursedById" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'The staff member who disbursed an application is recorded only with the DISBURSED transition';
    END IF;
    disbursing := NEW."status" = 'DISBURSED'::"AppStatus";
    countersigning := NEW."agreementCountersignedAt" IS NOT NULL;
  ELSE
    disbursing := NEW."status" = 'DISBURSED'::"AppStatus"
      AND OLD."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus";
    countersigning := OLD."agreementCountersignedAt" IS NULL
      AND NEW."agreementCountersignedAt" IS NOT NULL;
    IF NEW."disbursedById" IS DISTINCT FROM OLD."disbursedById" AND NOT disbursing THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'The staff member who disbursed an application is recorded only with the DISBURSED transition';
    END IF;
  END IF;

  IF disbursing AND NEW."disbursedById" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u."id" = NEW."disbursedById"
      AND u."tenantId" = NEW."tenantId"
      AND u."active" = TRUE
      AND u."role" IN (
        'LOAN_ADMIN'::"UserRole",
        'BRANCH_MANAGER'::"UserRole",
        'ADMIN'::"UserRole",
        'SUPER_ADMIN'::"UserRole"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A disbursement is recorded against an active staff member of the application tenant who may disburse';
  END IF;

  IF NEW."entityId" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."id" AND d."tenantId" = NEW."tenantId"
  ) THEN
    RETURN NEW;
  END IF;

  IF disbursing AND "tenantRequiresSegregationOfDuties"(NEW."tenantId") THEN
    IF NEW."disbursedById" IS NULL OR LENGTH(BTRIM(NEW."disbursedById")) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: a disbursement must record the staff member who made it';
    END IF;
    IF NEW."disbursedById" = NEW."approvedById" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: the staff member who approved an application cannot disburse it';
    END IF;
  END IF;

  IF countersigning
    AND NEW."agreementSignedMethod" = 'branch'
    AND NEW."agreementSignedByUserId" = NEW."agreementCountersignedById"
    AND "tenantRequiresSegregationOfDuties"(NEW."tenantId")
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Segregation of duties: the staff witness of the in-branch signature cannot countersign for the provider';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_z_require_segregation_of_duties_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationSegregationOfDuties"();

CREATE OR REPLACE FUNCTION public."guardLoanApplicationConsumerSignature"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."agreementSignedAt" IS NOT NULL
    AND (
      NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
      OR NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
      OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
      OR NEW."agreementSignedByIp" IS DISTINCT FROM OLD."agreementSignedByIp"
      OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"
    )
    AND NOT (
      NEW."agreementSignedAt" IS NULL
      AND NEW."agreementSignedMethod" IS NULL
      AND NEW."agreementSignedByUserId" IS NULL
      AND NEW."agreementSignedByIp" IS NULL
      AND NEW."agreementSignatureData" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A recorded consumer signature is immutable; return the application to review to take a new one';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_guard_consumer_signature_frozen" BEFORE UPDATE OF "agreementSignedAt", "agreementSignedMethod", "agreementSignedByUserId", "agreementSignedByIp", "agreementSignatureData" ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationConsumerSignature"();
