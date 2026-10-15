import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { applicationStatementInsights } from "@/lib/credit-checks/statement-insights"
import { getVlmConfig } from "@/lib/vlm-extract"

/**
 * GET /api/applications/[id]/statement-insights — financial-health figures from
 * the client's read statements (lib/statement-analysis/insights.ts). The
 * figures summarise the statements' rows, which is document access: each
 * statement summarised is logged.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // A GET that writes access-log rows: another site must not trigger it with the officer's cookies.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
  }
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const result = await applicationStatementInsights(tenant.id, id)
    if (!result) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    await logDocumentContentAccess({ documentIds: result.read.map((s) => s.documentId), staffUserId: guard.user.id, action: "statement_insights", req })
    // Whether rows no rule categorises can be labelled by the model at all.
    return NextResponse.json({ ...result.insights, unreadStatements: result.unread, modelLabelsEnabled: getVlmConfig() !== null })
  })
}
