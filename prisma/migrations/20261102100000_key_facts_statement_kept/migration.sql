-- The statement a borrower was shown before applying is evidence of that application (tender 2.2.4,
-- lib/non-nca-documents/pre-submission.ts). Once an application has claimed it, ClientDocument.issuedForApplicationId
-- is set and its file is kept as an issued document's is: not deleted, soft or hard, not replaced, not re-pointed
-- at another application. Before the claim the row is the borrower's ordinary document, and the claim itself
-- (null to an application) passes. Nothing about a document without issuedForApplicationId changes, so no ZA row is touched.
--
-- Rollback (hand-written): restore guardLoanDocumentFile from 20261102090000_key_facts_offer_arrears_letter.

CREATE OR REPLACE FUNCTION public."guardLoanDocumentFile"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  referenced boolean;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  referenced := OLD."issuedForApplicationId" IS NOT NULL
    OR EXISTS (SELECT 1 FROM public."LoanDocumentIssuance" WHERE "clientDocumentId" = OLD."id")
    OR EXISTS (SELECT 1 FROM public."LoanArrearsLetter" WHERE "clientDocumentId" = OLD."id");
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF NOT referenced THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document issued as a key facts statement or loan agreement cannot be deleted';
  END IF;
  IF NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document issued as a key facts statement or loan agreement cannot be deleted';
  END IF;
  IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath" OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."issuedForApplicationId" IS DISTINCT FROM OLD."issuedForApplicationId" OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."generatedFromVersionId" IS DISTINCT FROM OLD."generatedFromVersionId" OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The file of an issued key facts statement or loan agreement cannot be replaced';
  END IF;
  RETURN NEW;
END;
$function$;
