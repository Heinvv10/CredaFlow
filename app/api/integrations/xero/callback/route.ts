import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { XeroError } from "@/lib/accounting/xero/client"
import { completeXeroConnect } from "@/lib/accounting/xero/connection"

// Xero redirects the signed-in admin here (XERO_REDIRECT_URI). The state must
// be the one this admin started for this tenant within 10 minutes; it is
// single-use. The browser lands back on Settings → Integrations either way.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const back = (result: string) => NextResponse.redirect(new URL(`/settings/integrations?xero=${result}`, req.url), 303)
  return withTenantContext(req, async (tenant) => {
    const code = req.nextUrl.searchParams.get("code")
    const state = req.nextUrl.searchParams.get("state")
    const audit = (action: string, newValue: Record<string, unknown>) => logAuditStrict({
      tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action, entity: "XeroConnection", entityId: tenant.id, newValue,
    })
    if (!code || !state) {
      await audit(AuditAction.XERO_CONNECT_FAILED, { reason: req.nextUrl.searchParams.get("error") ?? "missing code or state" })
      return back("error")
    }
    try {
      const out = await completeXeroConnect(prisma, { tenantId: tenant.id, userId: guard.user.id, state, code })
      await audit(AuditAction.XERO_CONNECTED, out.status === "CONNECTED"
        ? { status: out.status, xeroTenantId: out.organisation.tenantId, organisation: out.organisation.tenantName }
        : { status: out.status, organisationsOffered: out.organisations.length })
      return back(out.status === "CONNECTED" ? "connected" : "select")
    } catch (error) {
      if (!(error instanceof XeroError)) throw error
      await audit(AuditAction.XERO_CONNECT_FAILED, { reason: error.message })
      return back("error")
    }
  })
}
