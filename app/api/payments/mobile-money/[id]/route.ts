import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { PaymentApplicationError } from "@/lib/loan/apply-payment"
import { ChargesError } from "@/lib/loan/charges-error"
import { canActOnPaymentNotifications } from "@/lib/payments/payment-notifications"
import { notifyReceiptBooked } from "@/lib/mobile-money/notify"
import {
  allocateMobileMoney, MobileMoneyReviewError, rejectMobileMoney, REJECT_REASON_MAX, REJECT_REASON_MIN,
} from "@/lib/mobile-money/review"

const STATUS: Record<MobileMoneyReviewError["code"], number> = {
  NOT_FOUND: 404, LOAN_NOT_FOUND: 404, ALREADY_RESOLVED: 409, SIMULATION_FORBIDDEN: 409, AMOUNT_UNCONFIRMED: 409,
}

/**
 * Allocate an M-Pesa transaction the ingest could not book (capture it as a
 * receipt on the loan staff name) or reject it. The same gate as allocating a
 * client-notified payment (app/api/payment-notifications/[id]/route.ts):
 * allocating is capturing a payment.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("COLLECTIONS_AGENT")
  if (guard.error) return guard.error
  if (!canActOnPaymentNotifications(guard.user.role)) {
    return NextResponse.json({ error: "Your role cannot record loan payments." }, { status: 403 })
  }
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { action?: unknown; loanReference?: unknown; reason?: unknown; confirmedAmount?: unknown } | null
    if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON body is required" }, { status: 400 })
    const actor = { id: guard.user.id, email: guard.user.email ?? null }
    try {
      if (body.action === "reject") {
        const reason = typeof body.reason === "string" ? body.reason.trim() : ""
        if (reason.length < REJECT_REASON_MIN || reason.length > REJECT_REASON_MAX) {
          return NextResponse.json({ error: `Give the reason for rejecting it (${REJECT_REASON_MIN}–${REJECT_REASON_MAX} characters)` }, { status: 400 })
        }
        return NextResponse.json(await rejectMobileMoney(prisma, { tenantId: tenant.id, id, reason, actor }))
      }
      if (body.action !== "allocate") return NextResponse.json({ error: "action must be allocate or reject" }, { status: 400 })
      const loanReference = typeof body.loanReference === "string" ? body.loanReference.trim() : ""
      if (!loanReference || loanReference.length > 100) {
        return NextResponse.json({ error: "Enter the reference of the loan to allocate it to" }, { status: 400 })
      }
      const { confirmedAmount } = body
      if (confirmedAmount !== undefined && (typeof confirmedAmount !== "number" || !Number.isSafeInteger(confirmedAmount) || confirmedAmount <= 0)) {
        return NextResponse.json({ error: "confirmedAmount must be a positive integer (cents)" }, { status: 400 })
      }
      const result = await allocateMobileMoney(prisma, {
        tenantId: tenant.id, id, loanReference, actor, ...(confirmedAmount === undefined ? {} : { confirmedAmount }),
      })
      if (!result.idempotentReplay) notifyReceiptBooked({ tenantId: tenant.id, loanId: result.loanId, payment: result.payment })
      return NextResponse.json({ transactionId: result.transactionId, status: "BOOKED", paymentId: result.payment.id })
    } catch (err) {
      if (err instanceof MobileMoneyReviewError) return NextResponse.json({ error: err.message }, { status: STATUS[err.code] })
      if (err instanceof ChargesError) return NextResponse.json({ error: err.message }, { status: 409 })
      if (err instanceof PaymentApplicationError) {
        if (err.code === "NOT_ACTIVE") return NextResponse.json({ error: "Loan is not active" }, { status: 409 })
        if (err.code === "NOT_FOUND") return NextResponse.json({ error: "Loan not found" }, { status: 404 })
        if (err.code === "INVALID_VALUE_DATE") {
          // The provider's date is fixed: this loan cannot take the payment, so say what can be done.
          return NextResponse.json({ error: `${err.message} This payment cannot be booked on that loan: allocate it to another loan or reject it.` }, { status: 422 })
        }
        return NextResponse.json({ error: err.message }, { status: 422 })
      }
      throw err
    }
  })
}
