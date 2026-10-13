import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { flagViews } from "@/lib/credit-checks/evidence"

/**
 * GET /api/applications/[id]/checks — recompute the application's credit-check
 * flags (before a decision only) and return them with their evidence rows.
 * Quoting statement rows is document access: each quoted document is logged.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // A GET that writes (flags, audit and access-log rows): another site must
  // not be able to trigger it with the officer's cookies.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
  }
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const result = await recomputeApplicationFlags(tenant.id, id, { userId: guard.user.id, email: guard.user.email })
    if (!result) return NextResponse.json({ error: "Application not found" }, { status: 404 })

    const { flags, documentIds } = await flagViews(tenant.id, result.flags)
    await logDocumentContentAccess({ documentIds, staffUserId: guard.user.id, action: "credit_check_evidence", req })
    return NextResponse.json({
      recomputed: result.recomputed,
      openCount: flags.filter((f) => f.status === "OPEN").length,
      flags,
    })
  })
}
