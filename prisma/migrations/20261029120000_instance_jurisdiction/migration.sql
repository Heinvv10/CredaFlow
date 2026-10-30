-- Jurisdiction, round 3 (lib/jurisdiction). Replaces the tenant-against-tenant
-- rule of 20261029110000_jurisdiction_instance_guard with one source of truth.
--
-- InstanceJurisdiction is a single row (id = 1, CHECK) holding the jurisdiction
-- and currency this instance serves. Every TenantConfig must equal it:
--   - a TenantConfig INSERT takes the instance's values whatever it carried: the
--     column defaults are ZA / ZAR and Prisma's upsert (INSERT ... ON CONFLICT)
--     inserts first, so refusing would break every settings writer on an LS
--     instance. A change of jurisdiction / currency / tenantId on an existing
--     config that would differ from the row is refused;
--   - a tenant becoming ACTIVE or PROVISIONING (or inserted so) whose config
--     differs is refused;
--   - the row cannot be changed once any LoanApplication or Loan has ever
--     existed (frozenAt, set by the first insert, so deleting every application
--     does not thaw it), cannot be deleted or truncated, and a change commits
--     only if every TenantConfig then equals it (deferred check).
--
-- LOCKING. Every guard takes the advisory lock hashtext('credaflow.instance_jurisdiction')
-- first (lockInstanceJurisdiction): exclusive in the guards of the instance row, of
-- config deletes and in the writer; shared in the tenant and config guards, which only
-- have to keep the instance from changing under them. So a tenant created while the row
-- is being changed waits and then sees the new value. A LoanApplication or Loan INSERT
-- takes the same lock in SHARED mode until it commits, so an instance change
-- waits for inserts in flight and then counts them. Waiting for a lock does not
-- refresh a REPEATABLE READ / SERIALIZABLE snapshot, so every guard refuses to
-- run outside READ COMMITTED (where each statement of the trigger sees what
-- committed while it waited). Guards read with app.rls_bypass on (restored afterwards).
--
-- The row is backfilled from ALL existing TenantConfigs, which must agree (the
-- invariant covers every lender, parked ones too); with none it is ZA / ZAR,
-- which is what every existing deployment is. A database whose lenders disagree
-- fails here. frozenAt is set when any application or loan already exists.
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
--   DROP TRIGGER "LoanApplication_hold_instance_jurisdiction" ON "LoanApplication";
--   DROP TRIGGER "Loan_hold_instance_jurisdiction" ON "Loan";
--   DROP FUNCTION public."guardTenantMatchesInstance"(), public."guardTenantConfigMatchesInstance"(),
--     public."guardTenantConfigDelete"(), public."guardInstanceJurisdictionChange"(),
--     public."guardInstanceJurisdictionTruncate"(), public."checkInstanceConfigsAgree"(),
--     public."holdInstanceJurisdiction"(), public."lockInstanceJurisdiction"(boolean);
--   DROP TABLE "InstanceJurisdiction";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029120000_instance_jurisdiction';
--   COMMIT;
--   (then re-create the 20261029101000 / 20261029110000 triggers from those files if needed)

CREATE TABLE "InstanceJurisdiction" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "currency" "LenderCurrency" NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setBy" TEXT NOT NULL DEFAULT 'migration',
    "frozenAt" TIMESTAMP(3),
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
  in_use boolean;
BEGIN
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT count(DISTINCT cfg."jurisdiction"::text || '/' || cfg."currency"::text), min(cfg."jurisdiction"::text), min(cfg."currency"::text)
    INTO kinds, j, c
    FROM public."TenantConfig" cfg;
  IF kinds > 1 THEN
    RAISE EXCEPTION 'Cannot create InstanceJurisdiction: the lenders of this database disagree about jurisdiction or currency';
  END IF;
  in_use := EXISTS (SELECT 1 FROM public."LoanApplication") OR EXISTS (SELECT 1 FROM public."Loan");
  INSERT INTO public."InstanceJurisdiction" ("id", "jurisdiction", "currency", "frozenAt")
    VALUES (1, coalesce(j, 'ZA')::public."Jurisdiction", coalesce(c, 'ZAR')::public."LenderCurrency", CASE WHEN in_use THEN now() END);
END
$backfill$;

CREATE OR REPLACE FUNCTION public."lockInstanceJurisdiction"(shared boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Exclusive for what changes the instance (or must see every insert in flight); shared for
  -- what only has to keep the instance from changing under it (a lender being created), so
  -- ordinary tenant and config writes do not queue behind one another.
  IF shared THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('credaflow.instance_jurisdiction'));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'));
  END IF;
  -- Waiting for the lock does not refresh a REPEATABLE READ / SERIALIZABLE snapshot: the
  -- reads after it would still miss what committed meanwhile. Refuse rather than guess.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '25000',
      MESSAGE = 'The instance jurisdiction guards need a READ COMMITTED transaction (this one is ' || current_setting('transaction_isolation') || ')';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardTenantConfigMatchesInstance"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  inst_j text;
  inst_c text;
BEGIN
  PERFORM public."lockInstanceJurisdiction"(true);
  SELECT "jurisdiction"::text, "currency"::text INTO inst_j, inst_c FROM public."InstanceJurisdiction" WHERE "id" = 1;
  IF inst_j IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A new config IS the instance's: the column defaults are ZA / ZAR, and an upsert
    -- inserts before it updates, so refusing here would break every settings writer.
    NEW."jurisdiction" := inst_j::public."Jurisdiction";
    NEW."currency" := inst_c::public."LenderCurrency";
    RETURN NEW;
  END IF;
  IF NEW."jurisdiction"::text <> inst_j OR NEW."currency"::text <> inst_c THEN
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
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  inst_j text;
  inst_c text;
  cfg_j text;
  cfg_c text;
BEGIN
  PERFORM public."lockInstanceJurisdiction"(true);
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
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  in_use boolean;
BEGIN
  -- The exclusive lock waits for an application insert still in flight.
  PERFORM public."lockInstanceJurisdiction"();
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
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  in_use boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."jurisdiction" = OLD."jurisdiction" AND NEW."currency" = OLD."currency" THEN
    -- setBy / setAt, and frozenAt (set by holdInstanceJurisdiction under a shared lock, so no
    -- exclusive lock here). Once frozen, always frozen.
    IF OLD."frozenAt" IS NOT NULL AND NEW."frozenAt" IS DISTINCT FROM OLD."frozenAt" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The instance jurisdiction is frozen: frozenAt cannot be changed or cleared';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM public."lockInstanceJurisdiction"();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The instance jurisdiction row cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_bypass := current_setting('app.rls_bypass', true);
    PERFORM set_config('app.rls_bypass', 'on', true);
    in_use := OLD."frozenAt" IS NOT NULL
           OR EXISTS (SELECT 1 FROM public."LoanApplication") OR EXISTS (SELECT 1 FROM public."Loan");
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
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The instance jurisdiction row cannot be truncated';
END;
$function$;

CREATE OR REPLACE FUNCTION public."checkInstanceConfigsAgree"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
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

CREATE OR REPLACE FUNCTION public."holdInstanceJurisdiction"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Shared: inserts do not block one another, only a change of the instance (exclusive).
  -- Held to the end of the transaction, so a change waits for an insert in flight and
  -- then sees it when it asks whether any application or loan exists. No snapshot is read
  -- here, so this works at any isolation level.
  PERFORM pg_advisory_xact_lock_shared(hashtext('credaflow.instance_jurisdiction'));
  -- The first application or loan ever freezes the instance for good, even if it is deleted later.
  UPDATE public."InstanceJurisdiction" SET "frozenAt" = now() WHERE "id" = 1 AND "frozenAt" IS NULL;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "InstanceJurisdiction_guard_change" BEFORE INSERT OR UPDATE OR DELETE ON "InstanceJurisdiction" FOR EACH ROW EXECUTE FUNCTION public."guardInstanceJurisdictionChange"();
CREATE TRIGGER "InstanceJurisdiction_guard_truncate" BEFORE TRUNCATE ON "InstanceJurisdiction" FOR EACH STATEMENT EXECUTE FUNCTION public."guardInstanceJurisdictionTruncate"();
CREATE CONSTRAINT TRIGGER "InstanceJurisdiction_configs_agree" AFTER INSERT OR UPDATE OF "jurisdiction", "currency" ON "InstanceJurisdiction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkInstanceConfigsAgree"();
CREATE TRIGGER "TenantConfig_guard_matches_instance" BEFORE INSERT OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardTenantConfigMatchesInstance"();
CREATE TRIGGER "TenantConfig_guard_delete_with_loans" BEFORE DELETE ON "TenantConfig" FOR EACH ROW EXECUTE FUNCTION public."guardTenantConfigDelete"();
CREATE TRIGGER "Tenant_guard_matches_instance" BEFORE INSERT OR UPDATE OF "status" ON "Tenant" FOR EACH ROW WHEN (NEW."status" IN ('ACTIVE', 'PROVISIONING')) EXECUTE FUNCTION public."guardTenantMatchesInstance"();
CREATE TRIGGER "LoanApplication_hold_instance_jurisdiction" BEFORE INSERT ON "LoanApplication" FOR EACH STATEMENT EXECUTE FUNCTION public."holdInstanceJurisdiction"();
CREATE TRIGGER "Loan_hold_instance_jurisdiction" BEFORE INSERT ON "Loan" FOR EACH STATEMENT EXECUTE FUNCTION public."holdInstanceJurisdiction"();
