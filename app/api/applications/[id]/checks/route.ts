import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logDocumentContentAccess } from "@/lib/document-auth"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { flagViews } from "@/lib/credit-checks/evidence"
import { enqueueApplication } from "@/lib/statement-ai/worker"
import { statementAiEnabled } from "@/lib/statement-ai/enabled"
import { flagExplanations } from "@/lib/statement-ai/views"
import { isCrossOriginRequest } from "@/lib/proxy/same-origin"

/** Advisory (Statement AI, if the lender has it): a failure here leaves the flags without explanations, never without the flags. */
async function explanationsFor(tenantId: string, applicationId: string): Promise<Map<string, string>> {
  try {
    return (await statementAiEnabled(tenantId)) ? await flagExplanations(tenantId, applicationId) : new Map()
  } catch (error) {
    // Only the name: a Prisma or model error's message can quote statement text.
    console.error("[checks] flag explanations failed:", error instanceof Error ? error.name : "unknown")
    return new Map()
  }
}

/**
 * GET /api/applications/[id]/checks — recompute the application's credit-check
 * flags (before a decision only) and return them with their evidence rows.
 * Quoting statement rows is document access: each quoted document is logged.
 * A lender with Statement AI on also gets each open flag's explanation
 * (`explanation`, written by code from the flag's own evidence) in that flag's
 * row; with it off, the response is as it always was.
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
    const explained = await explanationsFor(tenant.id, id)
    await logDocumentContentAccess({ documentIds, staffUserId: guard.user.id, action: "credit_check_evidence", req })
    return NextResponse.json({
      recomputed: result.recomputed,
      openCount: flags.filter((f) => f.status === "OPEN").length,
      flags: flags.map((f) => (explained.has(f.id) ? { ...f, explanation: explained.get(f.id) } : f)),
    })
  })
}
