/**
 * Lender identity — the ONE reader of who the credit provider is.
 *
 * Every caller that prints the lender's name, registration numbers, address
 * or contact details reads it here, from the tenant's own `TenantConfig` row
 * (see docs/ARCHITECTURE.md, "Tenancy and identity"). There are no
 * defaults: an unconfigured or invalid identity throws `LenderIdentityError`,
 * so a statutory document or customer message refuses to render instead of
 * printing someone else's registration.
 *
 * History: the inherited code printed a hardcoded NCR number
 * whatever the DB said, because a transposed digit once shipped from the DB.
 * The DB value now IS the printed value, so the guarantee moved to the write
 * side: lib/config/identity-write.ts validates with the schema below, demands
 * every statutory number twice when it changes, and audits each change.
 */
import { prisma } from "@/lib/prisma"
import {
  LENDER_IDENTITY_SELECT,
  LenderIdentityError,
  parseLenderIdentity,
  type LenderIdentity,
  type StoredLenderIdentityColumns,
} from "./identity-schema"

export * from "./identity-schema"

type IdentityReadDb = {
  tenant: {
    findUnique: (args: {
      where: { id: string }
      select: { name: true; config: { select: typeof LENDER_IDENTITY_SELECT } }
    }) => Promise<{ name: string; config: Partial<StoredLenderIdentityColumns> | null } | null>
  }
}

async function readTenant(tenantId: string, db: IdentityReadDb) {
  return db.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, config: { select: LENDER_IDENTITY_SELECT } },
  })
}

/**
 * The tenant's complete, validated identity. Throws `LenderIdentityError`
 * when anything required is missing or invalid. Use for every statutory
 * document and every message that reaches a customer.
 */
export async function getLenderIdentity(
  tenantId: string,
  db: IdentityReadDb = prisma as unknown as IdentityReadDb,
): Promise<LenderIdentity> {
  const tenant = await readTenant(tenantId, db)
  if (!tenant) throw new LenderIdentityError(["tenant"], "Lender identity is not configured: tenant not found.")
  return parseLenderIdentity(tenant.config)
}

/**
 * Like `getLenderIdentity`, but null when the tenant's identity is not (yet)
 * configured. For callers that must report "missing" rather than fail, such
 * as the document-template token guard. Never substitutes a default.
 */
export async function findLenderIdentity(
  tenantId: string,
  db: IdentityReadDb = prisma as unknown as IdentityReadDb,
): Promise<LenderIdentity | null> {
  try {
    return await getLenderIdentity(tenantId, db)
  } catch (e) {
    if (e instanceof LenderIdentityError) return null
    throw e
  }
}

/**
 * Display name for chrome that must render before identity is configured
 * (sign-in pages, staff shell, authenticator issuer): `brandName`, else the
 * tenant's own name. Both are DB values; there is no constant fallback.
 */
export async function getLenderBrandName(
  tenantId: string,
  db: IdentityReadDb = prisma as unknown as IdentityReadDb,
): Promise<string> {
  const tenant = await readTenant(tenantId, db)
  if (!tenant) throw new LenderIdentityError(["tenant"], "Lender identity is not configured: tenant not found.")
  const brand = tenant.config?.brandName?.trim()
  return brand || tenant.name
}
