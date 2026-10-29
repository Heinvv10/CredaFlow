-- Jurisdiction, round 3 (lib/jurisdiction). Replaces the tenant-against-tenant
-- rule of 20261029110000_jurisdiction_instance_guard with one source of truth.
--
-- InstanceJurisdiction is a single row (id = 1, CHECK) holding the jurisdiction
-- and currency this instance serves. Every TenantConfig must equal it:
--   - a TenantConfig insert, or a change to its jurisdiction / currency /
--     tenantId, that differs from the row is refused;
--   - a tenant becoming ACTIVE or PROVISIONING (or inserted so) whose config
--     differs is refused;
--   - the row cannot be changed once any LoanApplication or Loan exists, cannot
--     be deleted or truncated, and a change commits only if every TenantConfig
--     then equals it (deferred check).
-- Each of these takes pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'))
-- first, so a tenant created while the row is being changed waits and then sees
-- the new value. They read with app.rls_bypass on (restored afterwards).
--
-- The row is backfilled from the existing ACTIVE tenants, which must agree (the
-- previous migration already enforced it); with none it is ZA / ZAR, which is
-- what every existing deployment is. A database whose tenants disagree fails here.
--
-- TenantConfig can no longer be DELETEd once the lender has a loan application
-- or loan: lenders are retired by status, never deleted.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   DROP TRIGGER "Tenant_guard_matches_instance" ON "Tenant";
--   DROP TRIGGER "TenantConfig_guard_matches_instance" ON "TenantConfig";
--   DROP TRIGGER "TenantConfig_guard_delete_with_loans" ON "TenantConfig";
--   DROP TRIGGER "InstanceJurisdiction_guard_change" ON "InstanceJurisdiction";
--   DROP TRIGGER "InstanceJurisdiction_guard_truncate" ON "InstanceJurisdiction";
--   DROP TRIGGER "InstanceJurisdiction_configs_agree" ON "InstanceJurisdiction";
--   DROP FUNCTION public."guardTenantMatchesInstance"(), public."guardTenantConfigMatchesInstance"(),
--     public."guardTenantConfigDelete"(), public."guardInstanceJurisdictionChange"(),
--     public."guardInstanceJurisdictionTruncate"(), public."checkInstanceConfigsAgree"();
--   DROP TABLE "InstanceJurisdiction";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029120000_instance_jurisdiction';
--   COMMIT;
--   (then re-create the 20261029100000 / 20261029110000 triggers from those files if needed)

CREATE TABLE "InstanceJurisdiction" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "currency" "LenderCurrency" NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setBy" TEXT NOT NULL DEFAULT 'migration',
    CONSTRAINT "InstanceJurisdiction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InstanceJurisdiction" ADD CONSTRAINT "InstanceJurisdiction_singleton" CHECK (("id" = 1));
ALTER TABLE "InstanceJurisdiction" ADD CONSTRAINT "InstanceJurisdiction_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR'))));

-- The previous round's tenant-against-tenant objects, now redundant.
DROP TRIGGER "Tenant_guard_instance_jurisdiction" ON "Tenant";
DROP TRIGGER "TenantConfig_guard_instance_jurisdiction" ON "TenantConfig";
DROP FUNCTION public."guardInstanceJurisdiction"();
DROP TRIGGER "TenantConfig_guard_jurisdiction_change" ON "TenantConfig";
DROP FUNCTION public."guardTenantConfigJurisdictionChange"();

DO $backfill$
DECLARE
  kinds integer;
  j text;
  c text;
BEGIN
  SELECT count(DISTINCT cfg."jurisdiction"::text || '/' || cfg."currency"::text), min(cfg."jurisdiction"::text), min(cfg."currency"::text)
    INTO kinds, j, c
    FROM public."TenantConfig" cfg JOIN public."Tenant" t ON t."id" = cfg."tenantId"
    WHERE t."status" = 'ACTIVE';
  IF kinds > 1 THEN
    RAISE EXCEPTION 'Cannot create InstanceJurisdiction: the ACTIVE tenants of this database disagree about jurisdiction or currency';
  END IF;
  INSERT INTO public."InstanceJurisdiction" ("id", "jurisdiction", "currency")
    VALUES (1, coalesce(j, 'ZA')::"Jurisdiction", coalesce(c, 'ZAR')::"LenderCurrency");
END
$backfill$;

CREATE OR REPLACE FUNCTION public."guardTenantConfigMatchesInstance"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  inst_j text;
  inst_c text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'));
  SELECT "jurisdiction"::text, "currency"::text INTO inst_j, inst_c FROM public."InstanceJurisdiction" WHERE "id" = 1;
  IF inst_j IS NOT NULL AND (NEW."jurisdiction"::text <> inst_j OR NEW."currency"::text <> inst_c) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'One instance serves one jurisdiction: this instance is ' || inst_j || '/' || inst_c
        || ', this lender would be ' || NEW."jurisdiction"::text || '/' || NEW."currency"::text
        || '. Give that lender its own instance and database.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardTenantMatchesInstance"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  inst_j text;
  inst_c text;
  cfg_j text;
  cfg_c text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'));
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT "jurisdiction"::text, "currency"::text INTO inst_j, inst_c FROM public."InstanceJurisdiction" WHERE "id" = 1;
  SELECT "jurisdiction"::text, "currency"::text INTO cfg_j, cfg_c FROM public."TenantConfig" WHERE "tenantId" = NEW."id";
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  -- A tenant with no config yet is checked when its config is inserted.
  IF inst_j IS NOT NULL AND cfg_j IS NOT NULL AND (cfg_j <> inst_j OR cfg_c <> inst_c) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'One instance serves one jurisdiction: this instance is ' || inst_j || '/' || inst_c
        || ', this lender is ' || cfg_j || '/' || cfg_c
        || '. Give that lender its own instance and database.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardTenantConfigDelete"()
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
  in_use := EXISTS (SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = OLD."tenantId")
         OR EXISTS (SELECT 1 FROM public."Loan" WHERE "tenantId" = OLD."tenantId");
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF in_use THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lender''s configuration cannot be deleted once it has loan applications or loans: retire the lender by setting its status to SUSPENDED';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardInstanceJurisdictionChange"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  in_use boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'));
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The instance jurisdiction row cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."jurisdiction" = OLD."jurisdiction" AND NEW."currency" = OLD."currency" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_bypass := current_setting('app.rls_bypass', true);
    PERFORM set_config('app.rls_bypass', 'on', true);
    in_use := EXISTS (SELECT 1 FROM public."LoanApplication") OR EXISTS (SELECT 1 FROM public."Loan");
    PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
    IF in_use THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'The instance jurisdiction and currency cannot change once any loan application or loan exists. Set them before the first application, or move to a new instance.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardInstanceJurisdictionTruncate"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The instance jurisdiction row cannot be truncated';
END;
$function$;

CREATE OR REPLACE FUNCTION public."checkInstanceConfigsAgree"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  clash text;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT t."slug" || '=' || c."jurisdiction"::text || '/' || c."currency"::text INTO clash
    FROM public."TenantConfig" c JOIN public."Tenant" t ON t."id" = c."tenantId"
    WHERE c."jurisdiction" <> NEW."jurisdiction" OR c."currency" <> NEW."currency"
    LIMIT 1;
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'One instance serves one jurisdiction: a lender here is ' || clash
        || ' but the instance would be ' || NEW."jurisdiction"::text || '/' || NEW."currency"::text
        || '. Give that lender its own instance and database.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "InstanceJurisdiction_guard_change" BEFORE INSERT OR UPDATE OR DELETE ON "InstanceJurisdiction" FOR EACH ROW EXECUTE FUNCTION public."guardInstanceJurisdictionChange"();
CREATE TRIGGER "InstanceJurisdiction_guard_truncate" BEFORE TRUNCATE ON "InstanceJurisdiction" FOR EACH STATEMENT EXECUTE FUNCTION public."guardInstanceJurisdictionTruncate"();
CREATE CONSTRAINT TRIGGER "InstanceJurisdiction_configs_agree" AFTER INSERT OR UPDATE ON "InstanceJurisdiction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkInstanceConfigsAgree"();
CREATE TRIGGER "TenantConfig_guard_matches_instance" BEFORE INSERT OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardTenantConfigMatchesInstance"();
CREATE TRIGGER "TenantConfig_guard_delete_with_loans" BEFORE DELETE ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardTenantConfigDelete"();
CREATE TRIGGER "Tenant_guard_matches_instance" BEFORE INSERT OR UPDATE OF "status" ON "Tenant" FOR EACH ROW WHEN (NEW."status" IN ('ACTIVE', 'PROVISIONING')) EXECUTE FUNCTION public."guardTenantMatchesInstance"();
