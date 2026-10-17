import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { flagViews } from "@/lib/credit-checks/evidence"
import { enqueueApplication } from "@/lib/statement-ai/worker"
import { isCrossOriginRequest } from "@/lib/proxy/same-origin"

/**
 * GET /api/applications/[id]/checks — recompute the application's credit-check
 * flags (before a decision only) and return them with their evidence rows.
 * Quoting statement rows is document access: each quoted document is logged.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // A GET that writes (flags, audit and access-log rows): no other origin, a
  // sibling lender's host included, may trigger it with the officer's cookies.
  // proxy.ts gates only non-GET methods, so this route checks itself.
  if (isCrossOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 })
  }
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const result = await recomputeApplicationFlags(tenant.id, id, { userId: guard.user.id, email: guard.user.email })
    if (!result) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    // The flag set may have changed: Statement AI (if the lender has it) explains the new one, in the background.
    enqueueApplication(tenant.id, id)

    const { flags, documentIds } = await flagViews(tenant.id, result.flags)
    await logDocumentContentAccess({ documentIds, staffUserId: guard.user.id, action: "credit_check_evidence", req })
    return NextResponse.json({
      recomputed: result.recomputed,
      openCount: flags.filter((f) => f.status === "OPEN").length,
      flags,
    })
  })
}
