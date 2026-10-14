import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "./require-enabled"
import { requirePortalEntityAccess } from "./portal-access"

// The gate every portal asset-finance route passes, in order: a CLIENT
// session (401), the session bound to the request's tenant (403, in
// withTenantContext), the tenant's asset-finance flag (404), and — when the
// route names an entity — the client's authority over it (404,
// lib/asset-finance/portal-access.ts).

export interface PortalClient {
  clientId: string
  tenantId: string
  email: string | null
}

/** The signed-in portal client, or null for anyone else (staff included). */
export async function getPortalClient(): Promise<PortalClient | null> {
  const session = await auth()
  const user = session?.user
  if (!user || user.role !== "CLIENT" || !user.id || !user.tenantId) return null
  return { clientId: user.id, tenantId: user.tenantId, email: user.email ?? null }
}

export async function withPortalEntity(
  req: Request,
  entityId: string | null,
  handler: (ctx: { tenantId: string; client: PortalClient }) => Promise<Response>,
): Promise<Response> {
  const client = await getPortalClient()
  if (!client) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (entityId !== null) {
      const denied = await requirePortalEntityAccess(tenant.id, client.clientId, entityId)
      if (denied) return denied
    }
    return handler({ tenantId: tenant.id, client })
  })
}
