import { notFound, redirect } from "next/navigation"
import { getSession } from "@/lib/auth-session"
import { redirectStaleSession } from "@/lib/auth-guards"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"

/**
 * The tenant a dashboard or portal page reads with: the signed-in principal's
 * own tenant, never the deployment default. A page that read with
 * getDefaultTenantId() showed every principal the default lender's rows,
 * whatever lender they belong to.
 *
 * A page renders in parallel with its layout, so the layout's session redirect
 * does not stop the page's queries from running: these helpers repeat it.
 * Neither ever falls back to a default tenant.
 */

/**
 * Staff pages and server actions under app/(dashboard). Mirrors the dashboard
 * layout: no session or no tenant → the stale-session route (a bare /login
 * redirect loops while the edge still trusts the cookie); a CLIENT → /portal.
 */
export async function getStaffTenantId(): Promise<string> {
  await ensureActiveJurisdiction()
  const session = await getSession()
  if (!session?.user) redirectStaleSession()
  if (session.user.role === "CLIENT") redirect("/portal")
  // A dealer session never reaches the staff workspace (lib/proxy/dealer-host.ts).
  if (session.user.role === "DEALER") notFound()
  const tenantId = session.user.tenantId
  if (!tenantId) redirectStaleSession()
  return tenantId
}

/**
 * Client-portal pages under app/(portal). Mirrors the portal layout: no
 * session → /portal/login; staff → /dashboard. A CLIENT session without a
 * tenant goes to the stale-session route, which clears the cookie and then
 * shows the portal sign-in form: /portal/login straight away would send a
 * signed-in client back to /portal, a redirect loop.
 */
export async function getPortalTenantId(): Promise<string> {
  await ensureActiveJurisdiction()
  const session = await getSession()
  if (!session?.user) redirect("/portal/login")
  if (session.user.role !== "CLIENT") redirect("/dashboard")
  const tenantId = session.user.tenantId
  if (!tenantId) redirectStaleSession("/portal")
  return tenantId
}
