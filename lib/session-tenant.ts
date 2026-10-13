import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth-session"
import { redirectStaleSession } from "@/lib/auth-guards"

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
  const session = await getSession()
  if (!session?.user) redirectStaleSession()
  if (session.user.role === "CLIENT") redirect("/portal")
  const tenantId = session.user.tenantId
  if (!tenantId) redirectStaleSession()
  return tenantId
}

/**
 * Client-portal pages under app/(portal). Mirrors the portal layout: no
 * session or no tenant → /portal/login; staff → /dashboard.
 */
export async function getPortalTenantId(): Promise<string> {
  const session = await getSession()
  if (!session?.user) redirect("/portal/login")
  if (session.user.role !== "CLIENT") redirect("/dashboard")
  const tenantId = session.user.tenantId
  if (!tenantId) redirect("/portal/login")
  return tenantId
}
