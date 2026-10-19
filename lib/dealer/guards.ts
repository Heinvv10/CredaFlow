/**
 * The guard every dealer portal API route passes (app/api/dealer/**): a DEALER
 * session (no session: 401), bound to the lender this host resolves, the
 * portal enabled for that lender now, and DEALER_ADMIN where the route asks.
 * Every refusal of a signed-in session is 404, a staff or client session's
 * and another lender's included: the dealer host shows nothing it does not
 * serve. The jwt callback has already re-applied lib/dealer/principal.ts.
 * A write must also say it is same-origin (spec deviation 23): proxy.ts
 * refuses a cross-site write on the dealer host first; withDealer repeats the
 * check so a route never depends on the proxy alone.
 *
 *   return withDealer(req, { admin: true }, async (actor) => { ... })
 */
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest, withTenantContext } from "@/lib/tenant"
import { crossSiteWrite } from "@/lib/proxy/operator-host"
import { isReadMethod } from "@/lib/proxy/operator-read-only"
import type { DealerActor } from "./actor"
import { DEALER_PORTAL_FLAG_SELECT, dealerPortalEnabled } from "./principal"

export type DealerGuardResult = { actor: DealerActor; error?: never } | { actor?: never; error: NextResponse }

export const dealerNotFound = () => NextResponse.json({ error: "Not found" }, { status: 404 })

export async function requireDealer(req: Request, opts: { admin?: true } = {}): Promise<DealerGuardResult> {
  const session = await auth()
  const user = session?.user
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  if (user.role !== "DEALER" || !user.id || !user.tenantId || !user.dealerId || !user.dealerRole || !user.email) {
    return { error: dealerNotFound() }
  }
  const tenant = await getTenantFromRequest(req)
  if (!tenant || tenant.id !== user.tenantId) return { error: dealerNotFound() }
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: DEALER_PORTAL_FLAG_SELECT })
  if (!dealerPortalEnabled(config)) return { error: dealerNotFound() }
  if (opts.admin && user.dealerRole !== "DEALER_ADMIN") return { error: dealerNotFound() }
  return {
    actor: { tenantId: tenant.id, dealerId: user.dealerId, dealerUserId: user.id, email: user.email, dealerRole: user.dealerRole },
  }
}

/** 403 for a write the browser does not say is same-origin (Origin or Sec-Fetch-Site); null otherwise. */
export function dealerCrossSiteRefusal(req: Request): NextResponse | null {
  if (isReadMethod(req.method) || !crossSiteWrite(req)) return null
  return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
}

/** The same-origin check, requireDealer, then the handler inside the lender's tenant scope (lib/tenant.ts). */
export async function withDealer(
  req: Request,
  opts: { admin?: true },
  handler: (actor: DealerActor) => Promise<Response>,
): Promise<Response> {
  const crossSite = dealerCrossSiteRefusal(req)
  if (crossSite) return crossSite
  const guard = await requireDealer(req, opts)
  if (guard.error) return guard.error
  const actor = guard.actor
  return withTenantContext(req, () => handler(actor))
}
