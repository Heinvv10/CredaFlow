import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { hasMinRole } from "@/lib/permissions"
import { withTenantContext } from "@/lib/tenant"
import { triggerNotification } from "@/lib/notifications"
import { PaymentApplicationError } from "@/lib/loan/apply-payment"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"
import {
  allocatePaymentNotification,
  PAYMENT_NOTIFICATION_MIN_ROLE,
  PaymentNotificationError,
  REJECT_REASON_MAX,
  rejectPaymentNotification,
} from "@/lib/payments/payment-notifications"

const PAYMENT_METHODS = new Set(["EFT", "CASH", "DEBIT_ORDER", "CARD"])

type Body = {
  action?: unknown
  amount?: unknown
  receivedAt?: unknown
  paymentMethod?: unknown
  valueDateOverrideReason?: unknown
  reason?: unknown
}

/**
 * Allocate a client-notified payment (capture it as a receipt) or reject it.
 * Same role as capturing a payment (POST /api/payments): allocating IS a
 * capture. Rejecting decides about money too, so it takes the same role.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PAYMENT_NOTIFICATION_MIN_ROLE)
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => ({}))) as Body
    const actor = { id: guard.user.id, email: guard.user.email ?? null }

    try {
      if (body.action === "reject") {
        const reason = typeof body.reason === "string" ? body.reason.trim() : ""
        if (reason.length < 5 || reason.length > REJECT_REASON_MAX) {
          return NextResponse.json(
            { error: `Give the reason for rejecting it (5–${REJECT_REASON_MAX} characters)` },
            { status: 400 },
          )
        }
        return NextResponse.json(await rejectPaymentNotification(prisma, { tenantId: tenant.id, id, actor, reason }))
      }

      if (body.action !== "allocate") {
        return NextResponse.json({ error: "action must be allocate or reject" }, { status: 400 })
      }
      if (body.amount !== undefined && (!Number.isInteger(body.amount) || (body.amount as number) <= 0)) {
        return NextResponse.json({ error: "amount must be a positive integer (cents)" }, { status: 400 })
      }
      const paymentMethod = body.paymentMethod ?? "EFT"
      if (typeof paymentMethod !== "string" || !PAYMENT_METHODS.has(paymentMethod)) {
        return NextResponse.json({ error: "paymentMethod is invalid" }, { status: 400 })
      }
      let receivedAt: Date | undefined
      if (body.receivedAt != null) {
        receivedAt = typeof body.receivedAt === "string" ? new Date(body.receivedAt) : new Date(Number.NaN)
        if (Number.isNaN(receivedAt.getTime())) {
          return NextResponse.json({ error: "receivedAt is not a valid date" }, { status: 400 })
        }
      }
      // As on POST /api/payments: dating a receipt beyond the staff window is a
      // loan administrator's reasoned decision.
      let valueDateOverride = null
      if (body.valueDateOverrideReason != null) {
        if (typeof body.valueDateOverrideReason !== "string") {
          return NextResponse.json({ error: "valueDateOverrideReason must be text" }, { status: 400 })
        }
        if (!hasMinRole(guard.user.role, "LOAN_ADMIN")) {
          return NextResponse.json(
            { error: "A loan administrator must authorise a payment dated outside the capture window." },
            { status: 403 },
          )
        }
        valueDateOverride = { reason: body.valueDateOverrideReason, approvedById: actor.id, approvedByEmail: actor.email }
      }

      const result = await allocatePaymentNotification(prisma, {
        tenantId: tenant.id,
        id,
        actor,
        amount: body.amount as number | undefined,
        receivedAt,
        paymentMethod,
        valueDateOverride,
      })
      if (!result.idempotentReplay && result.payment.allocationStatus !== "UNAPPLIED") {
        triggerNotification({
          tenantId: tenant.id,
          event: "payment_received",
          loanId: result.notification.loanId,
          data: { amount: result.payment.amount, paymentId: result.payment.id },
        }).catch((err) => {
          console.error("payment_received notification failed", { paymentId: result.payment.id, err })
        })
      }
      return NextResponse.json({ id, status: "ALLOCATED", paymentId: result.payment.id })
    } catch (err) {
      if (err instanceof PaymentNotificationError) {
        return NextResponse.json({ error: err.message }, { status: err.code === "NOT_FOUND" ? 404 : 409 })
      }
      if (err instanceof ChargesSyncRefused) {
        return NextResponse.json({ error: err.message }, { status: 409 })
      }
      if (err instanceof PaymentApplicationError) {
        if (err.code === "NOT_ACTIVE") return NextResponse.json({ error: "Loan is not active" }, { status: 409 })
        if (err.code === "NOT_FOUND") return NextResponse.json({ error: "Loan not found" }, { status: 404 })
        return NextResponse.json({ error: err.message }, { status: 422 })
      }
      throw err
    }
  })
}
