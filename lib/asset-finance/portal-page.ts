import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { requirePortalEntityAccess } from "./portal-access"

// The page half of lib/asset-finance/portal-route.ts. The tenant is the
// session's own (session.user.tenantId), never a resolved or default one.
// Anything a client may not see is a 404, exactly as the API answers.

export async function requirePortalAssetFinancePage(): Promise<{ tenantId: string; clientId: string }> {
  const session = await auth()
  const user = session?.user
  if (!user) redirect("/portal/login")
  if (user.role !== "CLIENT" || !user.id || !user.tenantId) notFound()
  const flags = resolveFeatureFlags(await getTenantConfig(user.tenantId))
  if (!flags.featureAssetFinance) notFound()
  return { tenantId: user.tenantId, clientId: user.id }
}

export async function requirePortalEntityPage(entityId: string): Promise<{ tenantId: string; clientId: string }> {
  const ctx = await requirePortalAssetFinancePage()
  if (await requirePortalEntityAccess(ctx.tenantId, ctx.clientId, entityId)) notFound()
  return ctx
}
