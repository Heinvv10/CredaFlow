-- Kenya (lib/jurisdiction, KE-0): a KE lender, and a KE instance, are billed in KES only.
-- The rule of 20261029101000_jurisdiction_guards and 20261029120000_instance_jurisdiction
-- (ZA rand only, LS loti or rand) gains one pair; the ZA and LS pairs are unchanged, so
-- every existing row still passes. It mirrors `allowedCurrencies` in
-- lib/jurisdiction/profiles.ts (lib/jurisdiction/migration.test.ts compares them).
--
-- No trigger or function changes: the instance guards compare a lender with the instance
-- row without naming a jurisdiction, so they hold a KE instance as they hold LS.
--
-- Rollback (hand-written; Prisma has no down migrations). Only while no row is KE:
--   BEGIN;
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_jurisdiction_currency";
--   ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR'))));
--   ALTER TABLE "InstanceJurisdiction" DROP CONSTRAINT "InstanceJurisdiction_jurisdiction_currency";
--   ALTER TABLE "InstanceJurisdiction" ADD CONSTRAINT "InstanceJurisdiction_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR'))));
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108090100_kenya_jurisdiction_currency';
--   COMMIT;

ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_jurisdiction_currency";
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR')) OR ("jurisdiction" = 'KE' AND "currency" = 'KES')));

ALTER TABLE "InstanceJurisdiction" DROP CONSTRAINT "InstanceJurisdiction_jurisdiction_currency";
ALTER TABLE "InstanceJurisdiction" ADD CONSTRAINT "InstanceJurisdiction_jurisdiction_currency" CHECK ((("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR')) OR ("jurisdiction" = 'KE' AND "currency" = 'KES')));
