import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { applicationStatementInsights } from "@/lib/credit-checks/statement-insights"
import { statementWorkbook } from "@/lib/credit-checks/statement-export"
import { CATEGORISER_VERSION } from "@/lib/statement-analysis/categorise"

/**
 * GET /api/applications/[id]/statement-export — the client's read statements
 * as an .xlsx (lib/credit-checks/statement-export.ts). A download is document
 * access to every statement in it and is audited; both are written before the
 * file is returned, so an export that cannot be recorded is not served.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
  }
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { reference: true } })
    const result = application ? await applicationStatementInsights(tenant.id, id) : null
    if (!application || !result) return NextResponse.json({ error: "Application not found" }, { status: 404 })

    const documentIds = result.read.map((s) => s.documentId)
    await logDocumentContentAccess({ documentIds, staffUserId: guard.user.id, action: "statement_export", req })
    await logAuditStrict({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email ?? undefined,
      action: AuditAction.STATEMENT_EXPORTED,
      entity: "LoanApplication",
      entityId: id,
      newValue: { documentIds, categoriserVersion: CATEGORISER_VERSION },
    })

    const today = new Date().toISOString().slice(0, 10)
    // The application reference, never the client's name.
    const filename = `statements-${application.reference.replace(/[^A-Za-z0-9_-]/g, "")}-${today}.xlsx`
    const buffer = await statementWorkbook(result, application.reference, today).xlsx.writeBuffer()
    return new NextResponse(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  })
}
