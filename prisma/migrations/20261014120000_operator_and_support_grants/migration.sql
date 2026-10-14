-- Operator level above Tenant (W0, platform foundation).
--
-- An Operator runs lenders (CredaFlow is the root operator; a reseller is
-- another). Operator staff hold OPERATOR_ADMIN / OPERATOR_SUPPORT and are bound
-- to an operator, never to a tenant. They see no borrower data unless a
-- lender's ADMIN or SUPER_ADMIN grants time-boxed support access
-- (TenantSupportGrant, read by lib/operator/tenant-access.ts).
--
-- Adds enforcement (CHECKs, a guard trigger) on new columns and a new table
-- only: no code path writes them before this release, so nothing running is
-- refused.

ALTER TYPE "UserRole" ADD VALUE 'OPERATOR_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'OPERATOR_SUPPORT';

CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Operator_slug_key" ON "Operator"("slug");

ALTER TABLE "Tenant" ADD COLUMN "operatorId" TEXT;
CREATE INDEX "Tenant_operatorId_idx" ON "Tenant"("operatorId");
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "operatorId" TEXT;
CREATE INDEX "User_operatorId_idx" ON "User"("operatorId");
ALTER TABLE "User" ADD CONSTRAINT "User_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TenantSupportGrant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantSupportGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TenantSupportGrant_tenantId_operatorUserId_expiresAt_idx" ON "TenantSupportGrant"("tenantId", "operatorUserId", "expiresAt");
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_tenantId_grantedById_fkey" FOREIGN KEY ("tenantId", "grantedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_tenantId_revokedById_fkey" FOREIGN KEY ("tenantId", "revokedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written ─────────────────────────────────────────────────────────────

-- The root operator, and every existing lender under it. Tenant.operatorId
-- stays nullable until the operator console (W1) provisions lenders with one.
INSERT INTO "Operator" ("id", "slug", "name", "updatedAt")
VALUES ('cf_root_operator', 'credaflow', 'CredaFlow', CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
UPDATE "Tenant" SET "operatorId" = (SELECT "id" FROM "Operator" WHERE "slug" = 'credaflow')
WHERE "operatorId" IS NULL;

-- Operator staff are bound to an operator and to no tenant; tenant staff to no
-- operator. Compared as text: an enum value added in this migration cannot be
-- used as an enum literal in the same transaction.
ALTER TABLE "User" ADD CONSTRAINT "User_operator_binding_check" CHECK (
  ("role"::text IN ('OPERATOR_ADMIN', 'OPERATOR_SUPPORT')) = ("operatorId" IS NOT NULL)
  AND NOT ("operatorId" IS NOT NULL AND "tenantId" IS NOT NULL)
);

-- At most 7 days, counted from the grant's creation.
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_window_check" CHECK (
  "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '7 days'
);
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_revocation_check" CHECK (
  ("revokedAt" IS NULL) = ("revokedById" IS NULL)
);
ALTER TABLE "TenantSupportGrant" ADD CONSTRAINT "TenantSupportGrant_reason_check" CHECK (
  length(btrim("reason")) > 0
);

-- A grant names an active operator user of the operator that runs this
-- tenant, is given by an active ADMIN or SUPER_ADMIN of the tenant (the
-- compound foreign key binds the granter to the tenant), and starts now.
-- After insert only the revocation may be recorded, once. Grants are evidence:
-- they are not deleted.
CREATE OR REPLACE FUNCTION public.tenant_support_grant_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The second of slack absorbs TIMESTAMP(3) rounding the default up past
    -- clock_timestamp(); a createdAt set later than that would stretch the
    -- 7-day window past 7 days from now.
    IF NEW."createdAt" > clock_timestamp() + interval '1 second' OR NEW."expiresAt" <= clock_timestamp() THEN
      RAISE EXCEPTION 'Support grant must start now and expire in the future';
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Support grant cannot be inserted revoked';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "User" u JOIN "Tenant" t ON t."id" = NEW."tenantId"
      WHERE u."id" = NEW."operatorUserId"
        AND u."active"
        AND u."role"::text IN ('OPERATOR_ADMIN', 'OPERATOR_SUPPORT')
        AND u."operatorId" IS NOT NULL
        AND u."operatorId" = t."operatorId"
    ) THEN
      RAISE EXCEPTION 'Support grant must name an active operator user of the operator that runs this tenant';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "User" g
      WHERE g."id" = NEW."grantedById" AND g."tenantId" = NEW."tenantId"
        AND g."active" AND g."role"::text IN ('ADMIN', 'SUPER_ADMIN')
    ) THEN
      RAISE EXCEPTION 'Support grant must be given by an active ADMIN or SUPER_ADMIN of the tenant';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Support grants cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."operatorUserId" IS DISTINCT FROM OLD."operatorUserId"
     OR NEW."grantedById" IS DISTINCT FROM OLD."grantedById"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Support grant % can only be revoked, not changed', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Support grant % is already revoked', OLD."id";
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "TenantSupportGrant_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "TenantSupportGrant"
FOR EACH ROW EXECUTE FUNCTION public.tenant_support_grant_guard();
