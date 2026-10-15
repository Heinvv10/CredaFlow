import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { sendDisbursementPayout } from "@/lib/payouts/disbursement"
import { decidePayoutRetry, requestPayoutRetry } from "@/lib/payouts/retry"
import { acknowledgeDebitOrderCancelled, decideDisbursementReversal, requestDisbursementReversal } from "@/lib/payouts/reversal"
import { escalateRecovery, recordRecoveredFunds } from "@/lib/payouts/recovery"
import { valueDate } from "@/lib/payouts/resolve"

// The remedies for a payout that failed or came back (lib/payouts/retry.ts,
// lib/payouts/reversal.ts). LOAN_ADMIN; TOTP when the lender requires it.
// Actions: request_retry; decide_retry { payoutId, approve, note };
// request_reversal { reason }; decide_reversal { reversalId, approve, note }.
// After an approved reversal: ack_debit_order { reversalId, note } (the debit
// order was cancelled by hand); record_recovery { caseId, recoveredAt, note,
// reference? } and escalate_recovery { caseId, note } for money paid out on
// the reversed loan (lib/payouts/recovery.ts).
// Every decision is a second person's (maker-checker, DB-enforced).

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "")

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id: loanId } = await params
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "act on a payout")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as Record<string, unknown>
    const actor = { id: guard.user.id, email: guard.user.email }
    const note = text(body.note, 1000)

    switch (body.action) {
      case "request_retry": {
        const out = await requestPayoutRetry(prisma, { tenantId: tenant.id, loanId, actor })
        return out.ok ? NextResponse.json(out, { status: 201 }) : NextResponse.json({ error: out.error }, { status: out.status })
      }
      case "decide_retry": {
        if (typeof body.payoutId !== "string" || typeof body.approve !== "boolean") {
          return NextResponse.json({ error: "payoutId and approve are required" }, { status: 400 })
        }
        if (!body.approve && note.length < 5) return NextResponse.json({ error: "Say why the retry is rejected (at least 5 characters)" }, { status: 400 })
        const owned = await prisma.disbursementPayout.findFirst({ where: { id: body.payoutId, tenantId: tenant.id, loanId }, select: { id: true } })
        if (!owned) return NextResponse.json({ error: "Payout not found" }, { status: 404 })
        const out = await decidePayoutRetry(prisma, { tenantId: tenant.id, payoutId: body.payoutId, approve: body.approve, note: note || "approved", actor })
        if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
        // Approved: send now, through the usual claim. Never throws.
        const sent = out.status === "PENDING"
          ? await sendDisbursementPayout(prisma, { tenantId: tenant.id, payoutId: out.payoutId, actor })
          : null
        return NextResponse.json({ ...out, ...(sent ? { status: sent.status } : {}) })
      }
      case "request_reversal": {
        const reason = text(body.reason, 1000)
        if (reason.length < 10) return NextResponse.json({ error: "Give the reason the money never reached the borrower (at least 10 characters)" }, { status: 400 })
        const out = await requestDisbursementReversal(prisma, { tenantId: tenant.id, loanId, reason, actor })
        return out.ok ? NextResponse.json(out, { status: 201 }) : NextResponse.json({ error: out.error }, { status: out.status })
      }
      case "decide_reversal": {
        if (typeof body.reversalId !== "string" || typeof body.approve !== "boolean" || note.length < 5) {
          return NextResponse.json({ error: "reversalId, approve and a note of at least 5 characters are required" }, { status: 400 })
        }
        const owned = await prisma.disbursementReversal.findFirst({ where: { id: body.reversalId, tenantId: tenant.id, loanId }, select: { id: true } })
        if (!owned) return NextResponse.json({ error: "Reversal not found" }, { status: 404 })
        const out = await decideDisbursementReversal(prisma, { tenantId: tenant.id, reversalId: body.reversalId, approve: body.approve, note, actor })
        return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
      }
      case "ack_debit_order": {
        if (typeof body.reversalId !== "string" || note.length < 5) {
          return NextResponse.json({ error: "reversalId and a note of at least 5 characters (who cancelled it, and how) are required" }, { status: 400 })
        }
        const owned = await prisma.disbursementReversal.findFirst({ where: { id: body.reversalId, tenantId: tenant.id, loanId }, select: { id: true } })
        if (!owned) return NextResponse.json({ error: "Reversal not found" }, { status: 404 })
        const out = await acknowledgeDebitOrderCancelled(prisma, { tenantId: tenant.id, reversalId: body.reversalId, note, actor })
        return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
      }
      case "record_recovery":
      case "escalate_recovery": {
        if (typeof body.caseId !== "string" || note.length < 5) {
          return NextResponse.json({ error: "caseId and a note of at least 5 characters are required" }, { status: 400 })
        }
        const owned = await prisma.payoutRecoveryCase.findFirst({ where: { id: body.caseId, tenantId: tenant.id, loanId }, select: { id: true } })
        if (!owned) return NextResponse.json({ error: "Recovery case not found" }, { status: 404 })
        if (body.action === "escalate_recovery") {
          const out = await escalateRecovery(prisma, { tenantId: tenant.id, caseId: body.caseId, note, actor })
          return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
        }
        const recoveredAt = valueDate(body.recoveredAt)
        if (!recoveredAt) return NextResponse.json({ error: "recoveredAt must be the bank value date the funds came back (not in the future)" }, { status: 400 })
        const reference = text(body.reference, 200) || null
        const out = await recordRecoveredFunds(prisma, { tenantId: tenant.id, caseId: body.caseId, recoveredAt, note, reference, actor })
        return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
      }
      default:
        return NextResponse.json({ error: "action must be request_retry, decide_retry, request_reversal, decide_reversal, ack_debit_order, record_recovery or escalate_recovery" }, { status: 400 })
    }
  })
}
