-- BreachLog (the POPIA security-compromise register) had no tenant, so every
-- lender on a database shared one register. Each row now belongs to a Tenant.
--
-- Existing rows are assigned only where the owner is certain: a database with
-- exactly one tenant. With none, or more than one, the migration refuses and
-- changes nothing rather than guess whose incident a row is. IF NOT EXISTS is
-- the way out of that refusal: an operator adds the nullable column, assigns
-- each row and applies the migration again.
--
-- NOT NULL and the foreign key reject a write without a tenant from the moment
-- this applies, so it ships with the code that writes BreachLog.tenantId.
ALTER TABLE "BreachLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

DO $$
DECLARE
  unassigned BIGINT;
  tenants BIGINT;
BEGIN
  SELECT count(*) INTO unassigned FROM "BreachLog" WHERE "tenantId" IS NULL;
  IF unassigned = 0 THEN
    RETURN;
  END IF;

  SELECT count(*) INTO tenants FROM "Tenant";
  IF tenants <> 1 THEN
    RAISE EXCEPTION 'BreachLog has % row(s) without a tenant and this database has % tenants, so their owner cannot be inferred. Nothing was changed. Assign each row by hand: ALTER TABLE "BreachLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT; then UPDATE "BreachLog" SET "tenantId" = <Tenant.id> WHERE "id" = <BreachLog.id>; for every row, then run: prisma migrate resolve --rolled-back 20261011070000_breach_log_tenant_scope; prisma migrate deploy', unassigned, tenants;
  END IF;

  UPDATE "BreachLog" SET "tenantId" = (SELECT "id" FROM "Tenant") WHERE "tenantId" IS NULL;
END $$;

ALTER TABLE "BreachLog" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "BreachLog_tenantId_idx" ON "BreachLog"("tenantId");

-- AddForeignKey
ALTER TABLE "BreachLog" ADD CONSTRAINT "BreachLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
