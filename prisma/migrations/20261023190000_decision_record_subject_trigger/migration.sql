-- Learning loop: a decision record must be about someone who exists in its
-- own lender. CreditDecisionRecord.applicationId, loanId, clientId and leadId
-- carry no foreign key (a DSAR erasure of the parent must not be blocked, and
-- the table is append-only), so until now a writer's typo or a cross-lender
-- id was stored as given. This BEFORE INSERT trigger refuses a non-null
-- subject id that has no row, with the same tenantId, in its own table.
-- Insert-only: a parent deleted or erased later leaves its records in place.
--
-- SECURITY INVOKER, deliberately. The lookups run as the inserting role under
-- forced row-level security (20261014130000_tenant_rls), which already hides
-- another lender's rows; the explicit "tenantId" = NEW."tenantId" below makes
-- the rule hold when RLS is unrestricted too (no tenant frame, or
-- app.rls_bypass). A SECURITY DEFINER function would add a privilege to
-- protect nothing: a record whose tenant differs from the caller's frame is
-- refused by the table's own policy anyway.
--
-- The code that writes records (app/api/applications/*, app/api/portal/
-- applications, app/api/website/apply, lib/asset-finance/deal-decision.ts,
-- lib/learning-loop/submission-refusal.ts) passes only ids it has just read
-- or created in its own lender; the test fixtures that stored invented ids
-- now create the parent rows.
--
-- The error code is check_violation (23514), as the append-only guard's: Prisma
-- reports foreign_key_violation (23503) without its message, and the message
-- is what names the column.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TRIGGER "CreditDecisionRecord_subject_exists" ON "CreditDecisionRecord";
--   DROP FUNCTION public."guardCreditDecisionRecordSubjects"();
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023190000_decision_record_subject_trigger';
--   COMMIT;

CREATE OR REPLACE FUNCTION public."guardCreditDecisionRecordSubjects"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."applicationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."LoanApplication" WHERE "id" = NEW."applicationId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CreditDecisionRecord.applicationId is not an application of this tenant';
  END IF;
  IF NEW."loanId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."Loan" WHERE "id" = NEW."loanId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CreditDecisionRecord.loanId is not a loan of this tenant';
  END IF;
  IF NEW."clientId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."Client" WHERE "id" = NEW."clientId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CreditDecisionRecord.clientId is not a client of this tenant';
  END IF;
  IF NEW."leadId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."Lead" WHERE "id" = NEW."leadId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CreditDecisionRecord.leadId is not a lead of this tenant';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CreditDecisionRecord_subject_exists"
  BEFORE INSERT ON "CreditDecisionRecord"
  FOR EACH ROW EXECUTE FUNCTION public."guardCreditDecisionRecordSubjects"();
