import { NextRequest, NextResponse } from "next/server"
import { hasMinRole, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { isCrossOriginRequest } from "@/lib/proxy/same-origin"
import { statementAiEnabled } from "@/lib/statement-ai/enabled"
import { planOutputs } from "@/lib/statement-ai/generate"
import { modelAvailable } from "@/lib/statement-ai/model"
import { applicationAiView } from "@/lib/statement-ai/views"
import { enqueueApplication, enqueueQuestion } from "@/lib/statement-ai/worker"

/**
 * GET /api/applications/[id]/statement-ai — the advisory summary, flag
 * explanations and asked questions' answers (lib/statement-ai). Never calls the model: outputs the
 * current facts lack are queued for the background worker, and the panel
 * polls. 404 while the lender has Statement AI off. The text cites the
 * statements' rows, so showing it is document access: each statement is logged.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // A GET that writes access-log rows: no other origin may trigger it with the officer's cookies.
  if (isCrossOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 })
  }
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (!(await statementAiEnabled(tenant.id))) return NextResponse.json({ error: "Statement AI is not enabled" }, { status: 404 })
    const { id } = await ctx.params
    const planned = await planOutputs(tenant.id, id)
    if (!planned) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    // READONLY reads asked questions' answers (goal §5); the summary and explanations restate
    // the statement insights, which need CREDIT_OFFICER (statement-insights route).
    const summaries = hasMinRole(guard.user.role, "CREDIT_OFFICER")
    const view = await applicationAiView(tenant.id, id, planned, { summaries })
    if (summaries && view.pending > 0) enqueueApplication(tenant.id, id)
    // A question queued before a restart is queued again (the worker skips one already running or waiting).
    for (const a of view.answers) if (a.status === "PENDING") enqueueQuestion(tenant.id, id, a.id)
    await logDocumentContentAccess({ documentIds: planned.documentIds, staffUserId: guard.user.id, action: "statement_ai", req })
    return NextResponse.json({ ...view, noStatements: planned.summary === null, modelAvailable: modelAvailable() })
  })
}
