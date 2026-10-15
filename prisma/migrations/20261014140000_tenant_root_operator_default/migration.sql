-- New tenants belong to the root operator (W0 review A2). Every way a tenant
-- is made (prisma/seed.ts, scripts/lender/bootstrap-tenant.ts, lender
-- provisioning, POST /api/admin/tenants) omits operatorId, which left it
-- NULL: a lender no operator runs, and so one no support grant can reach.
-- The root operator row is inserted by 20261014120000_operator_and_support_grants.
ALTER TABLE "Tenant" ALTER COLUMN "operatorId" SET DEFAULT 'cf_root_operator';
