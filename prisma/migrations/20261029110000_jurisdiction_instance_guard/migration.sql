-- Jurisdiction, round 2 (lib/jurisdiction). Enforcement, so it ships with the
-- code that depends on it. Builds on 20261029101000_jurisdiction_guards.
--
-- 1. ONE JURISDICTION PER INSTANCE. The application holds the lender's
--    jurisdiction and currency process-wide and checks at boot that the ACTIVE
--    tenants agree. These two triggers keep that true afterwards: no statement
--    can leave two ACTIVE tenants with different jurisdiction or currency
--    (a tenant becoming ACTIVE, an ACTIVE tenant's config being inserted or
--    changed, a config moving to another tenant). A ZA lender provisioned or
--    reactivated on an LS instance is refused here, whatever path it takes.
--
-- 2. FREEZE. A lender with a loan application or loan keeps its jurisdiction
--    AND currency. Now also enforced on INSERT (a config re-created with other
--    values), on a tenantId change, and on DELETE of the config.
--
-- Both read Tenant, TenantConfig, LoanApplication and Loan with app.rls_bypass
-- on (restored afterwards), so a strict-RLS session cannot make them see no rows.
--
-- Operator escape for a lender that must change jurisdiction: do it before its
-- first application. After one exists the change needs a new instance and a
-- migration of the data; there is deliberately no SQL shortcut.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TRIGGER "Tenant_guard_instance_jurisdiction" ON "Tenant";
--   DROP TRIGGER "TenantConfig_guard_instance_jurisdiction" ON "TenantConfig";
--   DROP FUNCTION public."guardInstanceJurisdiction"();
--   DROP TRIGGER "TenantConfig_guard_jurisdiction_change" ON "TenantConfig";
--   DROP FUNCTION public."guardTenantConfigJurisdictionChange"();
--   -- then re-create both from 20261029101000_jurisdiction_guards
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029110000_jurisdiction_instance_guard';
--   COMMIT;

CREATE OR REPLACE FUNCTION public."guardInstanceJurisdiction"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  subject_tenant text;
  subject_active boolean;
  subject_jurisdiction text;
  subject_currency text;
  clash text;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);

  IF TG_TABLE_NAME = 'Tenant' THEN
    subject_tenant := NEW."id";
    subject_active := NEW."status"::text = 'ACTIVE';
    SELECT c."jurisdiction"::text, c."currency"::text INTO subject_jurisdiction, subject_currency
      FROM public."TenantConfig" c WHERE c."tenantId" = NEW."id";
  ELSE
    subject_tenant := NEW."tenantId";
    SELECT t."status"::text = 'ACTIVE' INTO subject_active FROM public."Tenant" t WHERE t."id" = NEW."tenantId";
    subject_jurisdiction := NEW."jurisdiction"::text;
    subject_currency := NEW."currency"::text;
  END IF;

  IF coalesce(subject_active, false) AND subject_jurisdiction IS NOT NULL THEN
    SELECT t."slug" || '=' || c."jurisdiction"::text || '/' || c."currency"::text INTO clash
      FROM public."TenantConfig" c JOIN public."Tenant" t ON t."id" = c."tenantId"
      WHERE t."status" = 'ACTIVE' AND t."id" <> subject_tenant
        AND (c."jurisdiction"::text <> subject_jurisdiction OR c."currency"::text <> subject_currency)
      LIMIT 1;
  END IF;

  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'One instance serves one jurisdiction: an ACTIVE lender here is ' || clash
        || ', this one would be ' || subject_jurisdiction || '/' || subject_currency
        || '. Give that lender its own instance and database.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Tenant_guard_instance_jurisdiction" BEFORE INSERT OR UPDATE OF "status" ON "Tenant" FOR EACH ROW WHEN (NEW."status" = 'ACTIVE') EXECUTE FUNCTION public."guardInstanceJurisdiction"();
CREATE TRIGGER "TenantConfig_guard_instance_jurisdiction" BEFORE INSERT OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardInstanceJurisdiction"();

CREATE OR REPLACE FUNCTION public."guardTenantConfigJurisdictionChange"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  subject text;
  in_use boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."jurisdiction"::text = 'ZA' AND NEW."currency"::text = 'ZAR' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."tenantId" = OLD."tenantId"
     AND NEW."jurisdiction" = OLD."jurisdiction" AND NEW."currency" = OLD."currency" THEN
    RETURN NEW;
  END IF;

  subject := CASE WHEN TG_OP = 'INSERT' THEN NEW."tenantId" ELSE OLD."tenantId" END;
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  in_use := EXISTS (SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = subject)
         OR EXISTS (SELECT 1 FROM public."Loan" WHERE "tenantId" = subject);
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF in_use THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lender''s jurisdiction and currency cannot change, and its configuration cannot be deleted, once it has loan applications or loans. Set them before the first application, or move the lender to a new instance.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER "TenantConfig_guard_jurisdiction_change" ON "TenantConfig";
CREATE TRIGGER "TenantConfig_guard_jurisdiction_change" BEFORE INSERT OR DELETE OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardTenantConfigJurisdictionChange"();
