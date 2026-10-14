import { NextRequest, NextResponse } from "next/server"
import type { DebitMandateAdjustment, DebitMandateAuthType } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { createDebitMandate } from "@/lib/collections-engine/mandates"
import { mandateErrorResponse } from "@/lib/collections-engine/http"

/**
 * POST /api/loans/[id]/collections-mandate
 * Body: { authType, debitDay, trackingDays, maxAmountCents?, adjustment? }
 *
 * Registers a DebiCheck mandate for the loan with the tenant's collection
 * provider and sends it for the debtor's authorisation. 409 while the
 * collections engine is off for the lender. Audited (COLLECTION_MANDATE_*).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    const debitDay = Number(body?.debitDay)
    const trackingDays = Number(body?.trackingDays)
    const maxAmountCents = body?.maxAmountCents === undefined || body.maxAmountCents === null ? undefined : Number(body.maxAmountCents)
    if (!body || typeof body.authType !== "string" || !Number.isInteger(debitDay) || !Number.isInteger(trackingDays)
      || (maxAmountCents !== undefined && !Number.isSafeInteger(maxAmountCents))) {
      return NextResponse.json({ error: "authType, a whole debitDay and whole trackingDays are required" }, { status: 422 })
    }
    try {
      const mandate = await createDebitMandate(tenant.id, { userId: guard.user.id, userEmail: guard.user.email }, {
        loanId: id,
        authType: body.authType as DebitMandateAuthType,
        debitDay,
        trackingDays,
        maxAmountCents,
        adjustment: typeof body.adjustment === "string" ? body.adjustment as DebitMandateAdjustment : undefined,
      })
      return NextResponse.json({ mandate: { id: mandate.id, status: mandate.status, statusReason: mandate.statusReason } }, { status: 201 })
    } catch (error) {
      const mapped = mandateErrorResponse(error)
      if (mapped) return mapped
      throw error
    }
  })
}
