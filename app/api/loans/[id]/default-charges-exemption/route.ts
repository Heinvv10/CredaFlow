import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled, loadChargesReplay } from "@/lib/loan/charges-replay"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { splitExcessToRefundDue } from "@/lib/loan/refund-excess"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"

class LoanNotFound extends Error {}

/**
 * PATCH /api/loans/[id]/default-charges-exemption
 * Body: { exempt: boolean, reason: string }
 *
 * An exempt loan carries no default charges at all. Setting or lifting it
 * re-derives the loan's charges in the same transaction, so the exemption and
 * its effect on the balance are one audited event.
 */
async function refundUnabsorbed(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  ref: { tenantId: string; loanId: string },
  now: Date,
  reason: string,
  user: { id: string; email?: string | null },
) {
  const replay = await loadChargesReplay(tx, ref, now)
  if (!replay || replay.result.unallocated === 0) return []
  return await splitExcessToRefundDue(tx, ref, replay.result.unallocated, `Default charges exemption: ${reason}`, {
    userId: user.id, userEmail: user.email ?? null,
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body = await req.json() as { exempt?: unknown; reason?: unknown }
      const reason = typeof body.reason === "string" ? body.reason.trim() : ""
      if (typeof body.exempt !== "boolean" || !reason || reason.length > 500) {
        return NextResponse.json(
          { error: "exempt (true or false) and a reason of up to 500 characters are required" },
          { status: 422 },
        )
      }
      const exempt = body.exempt

      try {
        const result = await prisma.$transaction(async (tx) => {
          await lockLoanForUpdate(tx, id)
          const loan = await tx.loan.findUnique({
            where: { id, tenantId: tenant.id },
            select: {
              defaultChargesExempt: true,
              defaultChargesExemptReason: true,
              tenant: CHARGES_FLAG_INCLUDE,
            },
          })
          if (!loan) throw new LoanNotFound()

          const now = new Date()
          // Lifting an exemption resumes charging from now; the exempt period
          // is never back-charged.
          const endedAt = loan.defaultChargesExempt && !exempt ? now : undefined
          await tx.loan.update({
            where: { id, tenantId: tenant.id },
            data: {
              defaultChargesExempt: exempt,
              defaultChargesExemptReason: reason,
              ...(endedAt ? { defaultChargesExemptEndedAt: endedAt } : {}),
            },
          })
          // Removing charges a client already paid turns that money into an
          // over-payment: it is split off the latest receipts as refund-due,
          // exactly as a capture books money beyond what is owed.
          const ref = { tenantId: tenant.id, loanId: id }
          const live = chargesEnabled(loan)
          const refunds = exempt && live
            ? await refundUnabsorbed(tx, ref, now, reason, guard.user)
            : []
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.DEFAULT_CHARGES_EXEMPTION_CHANGED,
              entity: "Loan",
              entityId: id,
              oldValue: {
                defaultChargesExempt: loan.defaultChargesExempt,
                reason: loan.defaultChargesExemptReason,
              },
              newValue: {
                defaultChargesExempt: exempt,
                reason,
                ...(endedAt ? { defaultChargesExemptEndedAt: endedAt.toISOString() } : {}),
                ...(refunds.length > 0 ? { refundDue: refunds } : {}),
              },
            },
          })
          const synced = live
            ? await syncLoanCharges(tx, ref, now, {
                source: "default_charges_exemption",
                userId: guard.user.id,
                userEmail: guard.user.email,
              })
            : null
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
          return { loanId: id, defaultChargesExempt: exempt, charges: synced, refundDue: refunds }
        })
        return NextResponse.json(result)
      } catch (error) {
        if (error instanceof LoanNotFound) {
          return NextResponse.json({ error: "Loan not found" }, { status: 404 })
        }
        if (error instanceof ChargesSyncRefused) {
          return NextResponse.json({ error: error.message }, { status: 409 })
        }
        throw error
      }
    })
  } catch (error) {
    console.error("Failed to change default-charges exemption:", error)
    return NextResponse.json({ error: "Failed to change default-charges exemption" }, { status: 500 })
  }
}
