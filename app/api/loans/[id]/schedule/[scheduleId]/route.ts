import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

interface RouteParams {
  params: Promise<{ id: string; scheduleId: string }>
}

/**
 * PATCH /api/loans/[id]/schedule/[scheduleId]
 * Admin action: flag an instalment as overdue/missed, or undo that flag.
 *
 * Body: { action: "flag_missed" | "revert" }
 *   flag_missed — sets status=OVERDUE (manual admin flag)
 *   revert      — undoes the flag: status back to what the paid amount says
 *
 * Neither touches money. An instalment's totalPaid is derived from the loan's
 * receipts (lib/loan/balances.ts allocateReceipts); setting it by hand made the
 * schedule disagree with Loan.totalPaid and every report rebuilt from receipts.
 * "mark_paid" is refused: record the receipt instead.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id: loanId, scheduleId } = await params

      // Validate the schedule entry belongs to the loan and tenant
      const entry = await prisma.repaymentSchedule.findUnique({
        where: { id: scheduleId, tenantId: tenant.id },
        select: { id: true, loanId: true, installmentNo: true, totalDue: true, totalPaid: true, status: true },
      })

      if (!entry) {
        return NextResponse.json({ error: "Schedule entry not found" }, { status: 404 })
      }

      if (entry.loanId !== loanId) {
        return NextResponse.json({ error: "Schedule entry does not belong to this loan" }, { status: 400 })
      }

      const body = await req.json() as { action: string }
      const { action } = body

      if (action === "mark_paid") {
        return NextResponse.json(
          { error: "Instalments are paid by recording a receipt, not by marking them paid" },
          { status: 409 },
        )
      }
      if (!["flag_missed", "revert"].includes(action)) {
        return NextResponse.json({ error: "Invalid action. Use: flag_missed, revert" }, { status: 400 })
      }
      if (action === "flag_missed" && ["OVERDUE", "PAID", "WRITTEN_OFF"].includes(entry.status)) {
        return NextResponse.json({ error: `An instalment that is ${entry.status.toLowerCase().replace("_", " ")} cannot be flagged as missed` }, { status: 409 })
      }
      if (action === "revert" && entry.status !== "OVERDUE") {
        return NextResponse.json({ error: "Only an overdue flag can be reverted" }, { status: 409 })
      }

      const updateData = action === "flag_missed"
        ? { status: "OVERDUE" as const }
        : {
            status: entry.totalPaid >= entry.totalDue
              ? "PAID" as const
              : entry.totalPaid > 0 ? "PARTIAL" as const : "PENDING" as const,
          }

      const updated = await prisma.repaymentSchedule.update({
        where: { id: scheduleId, tenantId: tenant.id },
        data: updateData,
      })

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email ?? undefined,
        action: action === "flag_missed" ? "SCHEDULE_INSTALMENT_FLAGGED_MISSED" : "SCHEDULE_INSTALMENT_FLAG_REVERTED",
        entity: "RepaymentSchedule",
        entityId: entry.id,
        oldValue: { status: entry.status },
        newValue: { status: updateData.status, loanId, installmentNo: entry.installmentNo },
      })

      // Also a loan note, so staff see it on the loan
      await prisma.loanNote.create({
        data: {
          tenantId: tenant.id,
          loanId,
          type: "general",
          note: `Admin action on instalment #${entry.installmentNo}: ${action.replace(/_/g, " ")} by ${guard.user.name ?? guard.user.email ?? "admin"}`,
          createdBy: guard.user.id ?? "admin",
        },
      })

      return NextResponse.json({ ok: true, entry: updated })
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: `Failed to update schedule entry: ${msg}` }, { status: 500 })
  }
}
