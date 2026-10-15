import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { XeroError } from "@/lib/accounting/xero/client"
import { disconnectXero, selectXeroOrganisation, startXeroConnect, xeroStatus } from "@/lib/accounting/xero/connection"

// Settings → Integrations → Xero. ADMIN. GET: status (never a token).
// POST { action: "connect" } returns the Xero sign-in URL (PKCE);
// { action: "select", xeroTenantId } picks an organisation;
// { action: "disconnect" }. Writes need TOTP when the lender requires it, and
// every one is audited.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await xeroStatus(prisma, tenant.id)))
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the Xero connection")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as Record<string, unknown>
    const audit = (action: string, newValue: Record<string, unknown>) => logAuditStrict({
      tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action,
      entity: "XeroConnection", entityId: tenant.id, ipAddress: callerIp(req), newValue,
    })
    try {
      if (body.action === "connect") {
        const url = await startXeroConnect(prisma, { tenantId: tenant.id, userId: guard.user.id })
        await audit(AuditAction.XERO_CONNECT_STARTED, {})
        return NextResponse.json({ url })
      }
      if (body.action === "select" && typeof body.xeroTenantId === "string") {
        const org = await selectXeroOrganisation(prisma, { tenantId: tenant.id, xeroTenantId: body.xeroTenantId })
        await audit(AuditAction.XERO_ORGANISATION_SELECTED, { xeroTenantId: org.tenantId, organisation: org.tenantName })
        return NextResponse.json(await xeroStatus(prisma, tenant.id))
      }
      if (body.action === "disconnect") {
        const { remoteCleanup } = await disconnectXero(prisma, { tenantId: tenant.id })
        await audit(AuditAction.XERO_DISCONNECTED, { remoteCleanup })
        return NextResponse.json({ ...(await xeroStatus(prisma, tenant.id)), remoteCleanup })
      }
      return NextResponse.json({ error: "action must be connect, select or disconnect" }, { status: 400 })
    } catch (error) {
      if (error instanceof XeroError) {
        return NextResponse.json({ error: error.message }, { status: error.kind === "config" ? 503 : 422 })
      }
      throw error
    }
  })
}
