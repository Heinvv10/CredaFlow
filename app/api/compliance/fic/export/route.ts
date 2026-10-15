import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { loadAllCtrForExport, listStrCases } from "@/lib/fic/registers"
import { ficTotpRefusal } from "@/lib/fic/session"
import { GOAML_DRAFT_NOTICE, buildCtrExport, buildStrExport } from "@/lib/fic/goaml-export"
import { logStrAccess } from "@/lib/fic/str-cases"

/**
 * GET /api/compliance/fic/export?register=ctr|str&format=csv|xml — a
 * "goAML-ready draft" of the register for MANUAL upload to goAML. Not
 * validated against the goAML schema; the file says so. FIC compliance role;
 * every export is audited, and an STR export is also an STR access.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const register = req.nextUrl.searchParams.get("register")
    const format = req.nextUrl.searchParams.get("format")
    if ((register !== "ctr" && register !== "str") || (format !== "csv" && format !== "xml")) {
      return NextResponse.json({ error: "register must be ctr or str, format csv or xml." }, { status: 400 })
    }
    const now = new Date()
    let body: string
    let rows: number
    if (register === "ctr") {
      const candidates = await loadAllCtrForExport(tenant.id)
      body = buildCtrExport(candidates, format, now)
      rows = candidates.length
    } else {
      const cases = await listStrCases(tenant.id)
      body = buildStrExport(cases, format, now)
      rows = cases.length
    }
    await prisma.$transaction(async (tx) => {
      if (register === "str") await logStrAccess(tx, { tenantId: tenant.id, userId: guard.user.id, action: "EXPORT" })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.FIC_EXPORTED,
        entity: register === "ctr" ? "CashThresholdReport" : "SuspiciousReportCase",
        newValue: { register, format, rows },
        ipAddress: callerIp(req),
      }, tx)
    })
    const stamp = now.toISOString().slice(0, 10)
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${register}-goaml-ready-draft-${stamp}.${format}"`,
        "Cache-Control": "no-store",
        "X-Export-Notice": GOAML_DRAFT_NOTICE,
      },
    })
  })
}
