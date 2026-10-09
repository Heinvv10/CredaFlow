import { Prisma } from "@prisma/client"
import { LenderIdentityError, parseRequiredIdentityField } from "@/lib/config/identity"

export interface StatutoryProviderIdentity {
  /** The credit provider's validated legal name (TenantConfig.legalName) —
   * what NCA documents print as the provider. Kept under its original field
   * name so the documents' evidence shape is unchanged. */
  tenantName: string
  configuredNcrNumber: string | null
  statutoryNcrNumber: string
}

/** The value when valid, else null (callers refuse to render). */
function valid(field: "legalName" | "ncrNumber", raw: string | null | undefined): string | null {
  try {
    return parseRequiredIdentityField(field, raw)
  } catch (e) {
    if (e instanceof LenderIdentityError) return null
    throw e
  }
}

export function statutoryProviderIdentityFromTenant(
  tenant: {
    config: { ncrNumber: string | null; legalName: string | null } | null
  },
): StatutoryProviderIdentity | null {
  if (!tenant.config) return null
  const legalName = valid("legalName", tenant.config.legalName)
  const statutoryNcrNumber = valid("ncrNumber", tenant.config.ncrNumber)
  if (!legalName || !statutoryNcrNumber) return null
  return {
    tenantName: legalName,
    configuredNcrNumber: tenant.config.ncrNumber,
    statutoryNcrNumber,
  }
}

export async function lockCurrentStatutoryProviderIdentity(
  tx: {
    $queryRaw: (
      query: Prisma.Sql,
    ) => Promise<Array<{ legalName: string | null; configuredNcrNumber: string | null }>>
  },
  tenantId: string,
  expected: StatutoryProviderIdentity,
): Promise<boolean> {
  const rows = await tx.$queryRaw(Prisma.sql`
    SELECT
      config."legalName" AS "legalName",
      config."ncrNumber" AS "configuredNcrNumber"
    FROM "Tenant" AS tenant
    JOIN "TenantConfig" AS config
      ON config."tenantId" = tenant."id"
    WHERE tenant."id" = ${tenantId}
    FOR SHARE OF tenant, config
  `)
  const current = rows[0]
  return rows.length === 1
    && valid("legalName", current.legalName) === expected.tenantName
    && current.configuredNcrNumber === expected.configuredNcrNumber
    && valid("ncrNumber", current.configuredNcrNumber) === expected.statutoryNcrNumber
}
