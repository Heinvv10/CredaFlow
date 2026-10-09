import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"
import {
  MAX_WAIVABLE_BALANCE_CENTS,
  SmallBalanceWaiverError,
  waiveSmallBalance,
} from "@/lib/loan/small-balance-waiver"

/**
 * POST /api/loans/[id]/small-balance-waiver
 * Body: { reason: string }
 *
 * Closes a loan whose entire charge-inclusive balance is 1–100 cents by booking
 * a non-cash WAIVER credit (lib/loan/small-balance-waiver.ts). Audited.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body = await req.json() as { reason?: unknown }
      const reason = typeof body.reason === "string" ? body.reason.trim() : ""
      if (!reason || reason.length > 500) {
        return NextResponse.json({ error: "A reason of up to 500 characters is required" }, { status: 422 })
      }

      try {
        const result = await waiveSmallBalance(prisma, {
          tenantId: tenant.id,
          loanId: id,
          reason,
          userId: guard.user.id,
          userEmail: guard.user.email ?? null,
        })
        return NextResponse.json(result)
      } catch (error) {
        if (error instanceof ChargesSyncRefused) {
          return NextResponse.json({ error: error.message }, { status: 409 })
        }
        if (!(error instanceof SmallBalanceWaiverError)) throw error
        if (error.code === "NOT_FOUND") {
          return NextResponse.json({ error: "Loan not found" }, { status: 404 })
        }
        if (error.code === "NOT_ACTIVE") {
          return NextResponse.json({ error: "Only an active or defaulted loan can have a balance waived" }, { status: 409 })
        }
        return NextResponse.json(
          {
            error: `Only a remaining balance of 1 to ${MAX_WAIVABLE_BALANCE_CENTS} cents can be waived`,
            settlementDueCents: error.settlementDueCents,
          },
          { status: error.settlementDueCents === 0 ? 409 : 422 },
        )
      }
    })
  } catch (error) {
    console.error("Failed to waive small balance:", error)
    return NextResponse.json({ error: "Failed to waive small balance" }, { status: 500 })
  }
}
