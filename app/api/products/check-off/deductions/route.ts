import { NextRequest, NextResponse } from "next/server"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { deductionsCsv, loadDeductions } from "@/lib/product-types/check-off"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

/** The month's salary-backed deductions: ?month=YYYY-MM, JSON, or ?format=csv for the file sent to the employers (audited). */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "view_check_off_deductions")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const month = req.nextUrl.searchParams.get("month") ?? ""
    const rows = await loadDeductions(prisma, tenant.id, month)
    if (!rows) return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 })
    if (req.nextUrl.searchParams.get("format") !== "csv") return NextResponse.json({ month, rows })
    await logAuditStrict({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.CHECK_OFF_DEDUCTIONS_EXPORTED, entity: "CheckOffDeductions", entityId: month, newValue: { month, rows: rows.length } })
    return new NextResponse(deductionsCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="check-off-${month}.csv"` } })
  })
}
