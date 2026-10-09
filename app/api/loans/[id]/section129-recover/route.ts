import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { recoverStaleSection129Issuance } from "@/lib/collections/section129-artifact"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * Make timed-out statutory issuances operable without enabling a blind retry.
 * Only LOAN_ADMIN may recover them: STAGING is deleted/released as known not
 * sent; READY/DISPATCHING is conservatively promoted for reconciliation.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id: loanId } = await params
    const body = await req.json().catch(() => ({})) as { issuanceId?: string }
    if (!body.issuanceId) {
      return NextResponse.json({ error: "issuanceId required" }, { status: 422 })
    }

    let result: Awaited<ReturnType<typeof recoverStaleSection129Issuance>>
    try {
      result = await recoverStaleSection129Issuance({
        tenantId: tenant.id,
        loanId,
        issuanceId: body.issuanceId,
        actorId: guard.user.id,
        actorEmail: guard.user.email,
      })
    } catch (error) {
      console.error("[section129-recover] timed-out issuance recovery failed", {
        tenantId: tenant.id,
        loanId,
        issuanceId: body.issuanceId,
        error,
      })
      return NextResponse.json(
        {
          error: "Recovery did not complete. The issuance remains locked; refresh before another attempt.",
          recoveryRequired: true,
        },
        { status: 503 },
      )
    }

    if (result.kind === "NO_ACTIVE_ISSUANCE") {
      return NextResponse.json(
        { error: "The active Section 129 issuance was not found or has already changed." },
        { status: 404 },
      )
    }
    if (result.kind === "NOT_STALE") {
      return NextResponse.json(
        { error: "The issuance has not exceeded the recovery timeout.", lifecycle: result.lifecycle },
        { status: 409 },
      )
    }
    return NextResponse.json({
      ok: true,
      issuanceId: result.issuanceId,
      outcome: result.kind,
      reconciliationRequired: result.kind === "RECONCILIATION_REQUIRED",
    })
  })
}
