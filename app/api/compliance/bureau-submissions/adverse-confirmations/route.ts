import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { dayOf, dayToDbDate, isDay } from "@/lib/bureau-submission/period"
import { adverseEventDay, isBureauSubmissionEnabled } from "@/lib/bureau-submission/staff-view.server"

/**
 * Confirm an adverse bureau listing: written off (W) or handed over (L).
 *
 * These land on a consumer's credit profile and cannot be undone by file, so
 * neither is ever sent on the loan's status alone. A staff member records the
 * date the consumer was given notice; from the next monthly file the status
 * is sent, once. Until then the loan reports its arrears with no status code.
 *
 * LOAN_ADMIN through the ordinary staff session (2FA applies as it does to
 * every staff write). The confirmation and its audit row commit together.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard

  return withTenantContext(req, async (tenant) => {
    if (!(await isBureauSubmissionEnabled(tenant.id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const body = (await req.json().catch(() => ({}))) as { loanId?: unknown; statusCode?: unknown; noticeDate?: unknown }
    const loanId = typeof body.loanId === "string" ? body.loanId : ""
    const noticeDate = typeof body.noticeDate === "string" ? body.noticeDate : ""
    const statusCode = body.statusCode
    if (statusCode !== "W" && statusCode !== "L") {
      return NextResponse.json({ error: "statusCode must be W or L" }, { status: 400 })
    }
    if (!isDay(noticeDate)) return NextResponse.json({ error: "noticeDate must be YYYY-MM-DD" }, { status: 400 })
    if (noticeDate > dayOf(new Date())) {
      return NextResponse.json({ error: "The notice date cannot be in the future" }, { status: 400 })
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, tenantId: tenant.id },
      select: {
        id: true, status: true, writeOffAt: true, collectionsStage: true,
        attorneyReferral: { select: { referralDate: true } },
      },
    })
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    if (!adverseEventDay(loan, statusCode).awaiting) {
      return NextResponse.json(
        { error: statusCode === "W" ? "This loan has not been written off" : "This loan has not been handed over to an attorney" },
        { status: 409 },
      )
    }

    try {
      const confirmation = await prisma.$transaction(async (tx) => {
        const created = await tx.bureauAdverseConfirmation.create({
          data: { tenantId: tenant.id, loanId: loan.id, statusCode, noticeDate: dayToDbDate(noticeDate), confirmedById: user.id },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.BUREAU_ADVERSE_LISTING_CONFIRMED,
          entity: "Loan",
          entityId: loan.id,
          newValue: { statusCode, noticeDate, confirmationId: created.id },
        }, tx)
        return created
      })
      return NextResponse.json({ id: confirmation.id, loanId: loan.id, statusCode, noticeDate }, { status: 201 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: "This listing was already confirmed" }, { status: 409 })
      }
      throw error
    }
  })
}
