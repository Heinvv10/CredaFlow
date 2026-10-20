/**
 * The page half of requireDealer (lib/dealer/guards.ts), for the portal pages
 * under app/(dealer)/dealer. The lender is the one the host resolves
 * (getResolvedTenantId reads the same host and edge-set slug as the API's
 * getTenantFromRequest); a DEALER session of another lender, a staff or
 * client session, the portal switched off, or a DEALER_SALES user on an
 * admin page all render 404. No session: the dealer sign-in. Each page calls
 * it itself: a page renders in parallel with its layout.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId } from "@/lib/tenant"
import { DEALER_LOGIN } from "@/lib/proxy/dealer-host"
import type { DealerActor } from "./actor"
import { DEALER_PORTAL_FLAG_SELECT, dealerPortalEnabled } from "./principal"

export async function requireDealerPage(opts: { admin?: true } = {}): Promise<DealerActor & { name: string | null }> {
  const session = await auth()
  const user = session?.user
  if (!user) redirect(DEALER_LOGIN)
  if (user.role !== "DEALER" || !user.id || !user.tenantId || !user.dealerId || !user.dealerRole || !user.email) notFound()
  const tenantId = await getResolvedTenantId()
  if (tenantId !== user.tenantId) notFound()
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: DEALER_PORTAL_FLAG_SELECT })
  if (!dealerPortalEnabled(config)) notFound()
  if (opts.admin && user.dealerRole !== "DEALER_ADMIN") notFound()
  return { tenantId, dealerId: user.dealerId, dealerUserId: user.id, email: user.email, dealerRole: user.dealerRole, name: user.name ?? null }
}
