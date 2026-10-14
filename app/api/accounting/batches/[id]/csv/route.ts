import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isCsvFormat, renderCsv } from "@/lib/accounting/csv"
import { BatchIntegrityError, loadBatchLines } from "@/lib/accounting/store"

// A closed month's journals as CSV. Rendered from the stored lines only, after
// checking them against the digest sealed at close; every download is audited.

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const format = req.nextUrl.searchParams.get("format") ?? "generic"
    if (!isCsvFormat(format)) return NextResponse.json({ error: "format must be generic or sage" }, { status: 400 })
    try {
      const lines = await loadBatchLines(prisma, tenant.id, id)
      const batch = await prisma.accountingExportBatch.findFirst({ where: { id, tenantId: tenant.id }, select: { periodKey: true } })
      if (!lines || !batch) return NextResponse.json({ error: "Closed batch not found" }, { status: 404 })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.ACCOUNTING_EXPORT_DOWNLOADED, entity: "AccountingExportBatch", entityId: id,
        newValue: { format, periodKey: batch.periodKey, lines: lines.length },
      })
      return new NextResponse(renderCsv(format, lines), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="journals-${batch.periodKey}-${format}.csv"`,
          "cache-control": "no-store",
        },
      })
    } catch (error) {
      if (error instanceof BatchIntegrityError) {
        console.error("[accounting]", error.message)
        return NextResponse.json({ error: "This batch failed its integrity check and cannot be exported." }, { status: 500 })
      }
      throw error
    }
  })
}
