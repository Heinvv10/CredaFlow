import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { cancelDebitMandate } from "@/lib/collections-engine/mandates"
import { mandateErrorResponse } from "@/lib/collections-engine/http"

/**
 * POST /api/loans/[id]/collections-mandate/[mandateId]/cancel
 * Body: { reason }
 *
 * Cancels the mandate with the provider first, then here, and cancels its
 * unsubmitted instructions. 409 while the collections engine is off.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; mandateId: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id, mandateId } = await params
    const body = await req.json().catch(() => null) as { reason?: unknown } | null
    const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
    if (!reason || reason.length > 500) {
      return NextResponse.json({ error: "A reason of up to 500 characters is required" }, { status: 422 })
    }
    const owned = await prisma.debitMandate.findFirst({ where: { id: mandateId, tenantId: tenant.id, loanId: id }, select: { id: true } })
    if (!owned) return NextResponse.json({ error: "Mandate not found" }, { status: 404 })
    try {
      const mandate = await cancelDebitMandate(tenant.id, { userId: guard.user.id, userEmail: guard.user.email }, mandateId, reason)
      return NextResponse.json({ mandate: { id: mandate.id, status: mandate.status } })
    } catch (error) {
      const mapped = mandateErrorResponse(error)
      if (mapped) return mapped
      throw error
    }
  })
}
