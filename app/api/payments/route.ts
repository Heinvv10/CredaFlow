import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
// The client-safe hierarchy check: zero imports, already covered by
// lib/__tests__/permissions.test.ts. Importing it from auth-guards drags
// next-auth into this route's test environment for no benefit.
import { hasMinRole } from "@/lib/permissions"
import { triggerNotification } from "@/lib/notifications"
import { withTenantContext } from "@/lib/tenant"
import { applyManualReceipt, PaymentApplicationError } from "@/lib/loan/apply-payment"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"
import {
  parsePaymentIdempotencyKey,
  PAYMENT_IDEMPOTENCY_HEADER,
} from "@/lib/payments/idempotency"

const PAYMENT_METHODS = new Set(["EFT", "CASH", "DEBIT_ORDER", "CARD"])

export async function POST(req: NextRequest) {
  try {
    // Collections agents capture the arrears payments they collect, so payment
    // recording is allowed from COLLECTIONS_AGENT upward (F-30). Lower roles
    // (READONLY, COLLECTIONS_OFFICER) still 403.
    const guard = await requireApiRole("COLLECTIONS_AGENT")
    if (guard.error) return guard.error

    // `await` so a re-thrown unexpected error from the callback is caught by the
    // outer try/catch and returned as a controlled 500 (a bare `return <promise>`
    // would let the rejection escape POST uncaught).
    return await withTenantContext(req, async (tenant) => {
      const idempotencyKey = parsePaymentIdempotencyKey(
        req.headers.get(PAYMENT_IDEMPOTENCY_HEADER),
      )
      if (!idempotencyKey) {
        return NextResponse.json(
          { error: `${PAYMENT_IDEMPOTENCY_HEADER} must be a valid 16-128 character key` },
          { status: 400 },
        )
      }

      const data = await req.json()

      if (typeof data.loanId !== "string" || !data.loanId) {
        return NextResponse.json({ error: "loanId is required" }, { status: 400 })
      }
      // amount is in cents and feeds legally load-bearing balance fields — reject
      // anything that isn't a positive integer.
      if (!Number.isInteger(data.amount) || data.amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive integer (cents)" }, { status: 400 })
      }
      const paymentMethod = data.paymentMethod ?? "EFT"
      if (typeof paymentMethod !== "string" || !PAYMENT_METHODS.has(paymentMethod)) {
        return NextResponse.json({ error: "paymentMethod is invalid" }, { status: 400 })
      }
      if (data.reference != null && typeof data.reference !== "string") {
        return NextResponse.json({ error: "reference must be text" }, { status: 400 })
      }
      if (data.notes != null && typeof data.notes !== "string") {
        return NextResponse.json({ error: "notes must be text" }, { status: 400 })
      }
      const reference = data.reference?.trim() || null
      const notes = data.notes?.trim() || null

      // Value date: when the money actually reached us. Optional — omitted means
      // today. An unparseable value must fail loudly rather than silently
      // defaulting to today and over-billing the client for the capture delay.
      let receivedAt: Date | undefined
      if (data.receivedAt != null) {
        if (typeof data.receivedAt !== "string") {
          return NextResponse.json({ error: "receivedAt must be a date string" }, { status: 400 })
        }
        receivedAt = new Date(data.receivedAt)
        if (Number.isNaN(receivedAt.getTime())) {
          return NextResponse.json({ error: "receivedAt is not a valid date" }, { status: 400 })
        }
      }

      // Dating a receipt beyond the staff window rebates earned interest, so it
      // is a senior, reasoned, recorded exception — not something the lowest
      // write role can do alone. COLLECTIONS_AGENT captures payments; only
      // LOAN_ADMIN upward may authorise a late-capture date.
      let valueDateOverride: { reason: string; approvedById: string; approvedByEmail: string | null } | null = null
      if (data.valueDateOverrideReason != null) {
        if (typeof data.valueDateOverrideReason !== "string") {
          return NextResponse.json({ error: "valueDateOverrideReason must be text" }, { status: 400 })
        }
        if (!hasMinRole(guard.user.role, "LOAN_ADMIN")) {
          return NextResponse.json(
            { error: "A loan administrator must authorise a payment dated outside the capture window." },
            { status: 403 },
          )
        }
        valueDateOverride = {
          reason: data.valueDateOverrideReason,
          approvedById: guard.user.id,
          approvedByEmail: guard.user.email ?? null,
        }
      }

      // The read-modify-write on the loan's balances (over-payment guard,
      // allocation, recompute) runs inside applyManualReceipt under a per-loan
      // FOR UPDATE lock, so concurrent receipts serialise instead of losing
      // updates (issue #422).
      let result
      try {
        result = await applyManualReceipt(prisma, {
          loanId: data.loanId,
          tenantId: tenant.id,
          amount: data.amount,
          paymentMethod,
          reference,
          notes,
          receivedAt,
          valueDateOverride,
          capturedById: guard.user.id,
          capturedByEmail: guard.user.email,
          idempotencyKey,
        })
      } catch (err) {
        if (err instanceof ChargesSyncRefused) {
          return NextResponse.json({ error: err.message }, { status: 409 })
        }
        if (err instanceof PaymentApplicationError) {
          if (err.code === "NOT_FOUND") {
            return NextResponse.json({ error: "Loan not found" }, { status: 404 })
          }
          if (err.code === "NOT_ACTIVE") {
            return NextResponse.json({ error: "Loan is not active" }, { status: 400 })
          }
          if (err.code === "IDEMPOTENCY_CONFLICT") {
            return NextResponse.json({ error: err.message }, { status: 409 })
          }
          // INVALID_VALUE_DATE and the rest are caller-fixable.
          return NextResponse.json({ error: err.message }, { status: 422 })
        }
        throw err
      }

      // The capture screen must be able to state how much is owed back WITHOUT
      // re-deriving it. Two shapes produce a refund: a partly-allocated receipt
      // with an excess sibling, and a receipt on a loan that owed nothing, which
      // is booked whole as UNAPPLIED with no sibling at all. Collapsing both
      // into one figure here is what stops the UI reporting the second case as
      // an ordinary payment.
      const refundDueAmount = result.excessPayment?.amount
        ?? (result.payment.allocationStatus === "UNAPPLIED" ? result.payment.amount : 0)

      if (!result.idempotentReplay) {
        // The durable receipt and audit committed together above. Notification
        // is intentionally post-commit and never repeats on an idempotent replay.
        //
        // Suppressed ONLY when the whole receipt is refund-due — i.e. nothing was
        // allocated and the loan was not written at all, so the template's "your
        // account is updated / outstanding balance" claim would be a plain
        // untruth. This matches the Stitch webhook's actual rule, which keys on
        // the receipt it created being UNAPPLIED.
        //
        // A SPLIT receipt still notifies. Suppressing those instead would mean a
        // client who over-pays by one cent — the likeliest over-payment there
        // is — settles their loan and receives no confirmation on any channel,
        // ever: payment_received is the only customer-facing receipt event in
        // the codebase, and reconcile re-emits it only on `allocate`, which a
        // split sibling can never reach (the split closes the loan, so allocate
        // 409s). Silence would be worse than a balance figure that omits the
        // refund; the refund is surfaced to staff on the reconcile tab.
        if (result.payment.allocationStatus !== "UNAPPLIED") {
          triggerNotification({
            tenantId: tenant.id,
            event: "payment_received",
            loanId: data.loanId,
            data: { amount: data.amount, paymentId: result.payment.id },
          }).catch((err) => {
            // A dropped customer notification on the money path must not be
            // invisible; the sibling paths both log theirs.
            console.error("payment_received notification failed", {
              paymentId: result.payment.id, err,
            })
          })
        }
      }

      return NextResponse.json({
        ...result.payment,
        excessPayment: result.excessPayment ?? null,
        refundDueAmount,
      }, {
        headers: { "Idempotency-Replayed": String(result.idempotentReplay) },
      })
    })
  } catch (error) {
    console.error("Failed to record payment:", error)
    return NextResponse.json(
      { error: "Failed to record payment" },
      { status: 500 }
    )
  }
}
