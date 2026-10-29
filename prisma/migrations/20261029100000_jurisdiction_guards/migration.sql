-- Jurisdiction guards (lib/jurisdiction). Enforcement, so it ships with the
-- code that depends on it (20261029090000_lender_jurisdiction added the columns).
--
-- 1. CHECK: a ZA lender is billed in ZAR only; an LS lender in LSL or ZAR (the
--    rand is legal tender in Lesotho). Every existing row is ZA / ZAR.
-- 2. TRIGGER: a lender's jurisdiction cannot change once it holds a
--    LoanApplication or a Loan. Money, NCA documents and the NCA gates have
--    all been decided under the old value. Setting it is an operator action on
--    the database before the first application; there is no app write path.
--
-- The trigger sets app.rls_bypass for its two lookups (and restores it), so a
-- strict-RLS session with no tenant frame cannot see zero rows and let the
-- change through.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TRIGGER "TenantConfig_guard_jurisdiction_change" ON "TenantConfig";
--   DROP FUNCTION public."guardTenantConfigJurisdictionChange"();
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_jurisdiction_currency";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029100000_jurisdiction_guards';
--   COMMIT;

ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR'))));

CREATE OR REPLACE FUNCTION public."guardTenantConfigJurisdictionChange"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  in_use boolean;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  in_use := EXISTS (SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = NEW."tenantId")
         OR EXISTS (SELECT 1 FROM public."Loan" WHERE "tenantId" = NEW."tenantId");
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF in_use THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lender''s jurisdiction cannot change once it has loan applications or loans';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "TenantConfig_guard_jurisdiction_change" BEFORE UPDATE OF "jurisdiction" ON "TenantConfig" FOR EACH ROW WHEN (OLD."jurisdiction" IS DISTINCT FROM NEW."jurisdiction") EXECUTE FUNCTION public."guardTenantConfigJurisdictionChange"();
