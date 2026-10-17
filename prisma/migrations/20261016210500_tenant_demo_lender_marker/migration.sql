-- The demo-lender marker (PR #147 review): a Section 129 notice is simulated on
-- a demo stack only for a tenant the demo seed or the demo stack scripts mark,
-- never by its slug. Additive, false for every existing row.

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "isDemoLender" BOOLEAN NOT NULL DEFAULT false;
