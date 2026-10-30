import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { sastCalendarDate, sastDayNumberStart } from "@/lib/date/sast"

/**
 * Debt review (NCA s.86): record, and clear, the notice that a debt counsellor
 * has the consumer under review. While it is recorded no automated reminder
 * reaches the loan (lib/collections/dunning-holds.ts).
 *
 * Same gate as the other collections actions (collections-stage/route.ts):
 * COLLECTIONS_OFFICER and up, minus INSURANCE_OFFICER via act_on_collections.
 * requireApiRole also holds a staff user who has not enrolled TOTP at the
 * enrolment page, so this write path does not skip 2FA.
 *
 * The change and its audit row commit in one transaction: a notice recorded
 * with no audit row, or an audit row for a notice that never landed, are both
 * false records. Recording over an existing notice is refused (409); clear it
 * first, so the trail shows both the removal and its reason.
 *
 * Section 86 is for natural persons, so an entity (juristic) borrower is refused
 * (409), as is a loan that is already COMPLETED, CANCELLED or WRITTEN_OFF. The
 * notice is consumer-wide: it holds the reminders and Section 129 for every
 * loan of the client (lib/collections/dunning-holds.ts, client-holds.ts).
 */

const MAX_REFERENCE = 100
const MAX_REASON = 500
const CLOSED_STATUSES = ["COMPLETED", "CANCELLED", "WRITTEN_OFF"]

/** Prisma's message can carry the query's values; the name and code identify the failure. */
function failureSummary(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" }
  const code = (error as { code?: unknown }).code
  return { name: error.name, ...(typeof code === "string" ? { code } : {}) }
}

type Params = { params: Promise<{ id: string }> }

async function guardCollections() {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return { error: guard.error }
  if (!canDo(guard.user.role, "act_on_collections")) {
    return { error: NextResponse.json({ error: "Your role cannot act on collections." }, { status: 403 }) }
  }
  return { user: guard.user }
}

/** "YYYY-MM-DD" -> SAST midnight, or null for anything that is not a real calendar day. */
function parseNoticeDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const date = sastDayNumberStart(year, month, day)
  return sastCalendarDate(date) === value ? date : null
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await guardCollections()
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("Debt review (NCA s86)")
  if (notNca) return notNca
  const { user } = guard

  return await withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null) ?? {}) as Record<string, unknown>

    const noticeAt = parseNoticeDate(body.noticeDate)
    if (!noticeAt) {
      return NextResponse.json({ error: "noticeDate must be a calendar date, YYYY-MM-DD" }, { status: 422 })
    }
    if (sastCalendarDate(noticeAt) > sastCalendarDate(new Date())) {
      return NextResponse.json({ error: "The notice date cannot be in the future" }, { status: 422 })
    }
    const reference = typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null
    if (reference && reference.length > MAX_REFERENCE) {
      return NextResponse.json({ error: `The reference is at most ${MAX_REFERENCE} characters` }, { status: 422 })
    }

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await lockLoanForUpdate(tx, id)
        const loan = await tx.loan.findUnique({
          where: { id, tenantId: tenant.id },
          select: { id: true, clientId: true, status: true, startDate: true, debtReviewNoticeAt: true, debtReviewNoticeRef: true },
        })
        if (!loan) return "NOT_FOUND" as const
        if (!loan.clientId) return "ENTITY_BORROWER" as const
        // Section 129 dispatch locks this Client row before it checks for a notice on
        // any of the client's loans; taking it here makes a notice on a sibling loan
        // and an in-flight dispatch serialise instead of passing each other.
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${loan.clientId} AND "tenantId" = ${tenant.id} FOR UPDATE`
        if (CLOSED_STATUSES.includes(loan.status)) return "CLOSED_LOAN" as const
        if (sastCalendarDate(noticeAt) < sastCalendarDate(loan.startDate)) return "BEFORE_START" as const
        if (loan.debtReviewNoticeAt) return "ALREADY_RECORDED" as const

        const updated = await tx.loan.update({
          where: { id, tenantId: tenant.id },
          data: { debtReviewNoticeAt: noticeAt, debtReviewNoticeRef: reference },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.DEBT_REVIEW_NOTICE_RECORDED,
          entity: "Loan",
          entityId: id,
          oldValue: { debtReviewNoticeAt: null, debtReviewNoticeRef: null },
          newValue: { debtReviewNoticeAt: sastCalendarDate(noticeAt), debtReviewNoticeRef: reference },
        }, tx)
        return updated
      })

      if (outcome === "NOT_FOUND") return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      if (outcome === "ENTITY_BORROWER") {
        return NextResponse.json({ error: "Debt review (NCA s.86) applies to individual consumers; this loan's borrower is a business entity." }, { status: 409 })
      }
      if (outcome === "CLOSED_LOAN") {
        return NextResponse.json({ error: "This loan is closed (completed, cancelled or written off); record the notice on the client's open loan." }, { status: 409 })
      }
      if (outcome === "BEFORE_START") {
        return NextResponse.json({ error: "The notice date cannot be before the loan's start date" }, { status: 422 })
      }
      if (outcome === "ALREADY_RECORDED") {
        return NextResponse.json(
          { error: "A debt-review notice is already recorded. Clear it, with a reason, before recording another." },
          { status: 409 },
        )
      }
      return NextResponse.json({
        debtReviewNoticeAt: outcome.debtReviewNoticeAt,
        debtReviewNoticeRef: outcome.debtReviewNoticeRef,
      })
    } catch (error) {
      console.error(`[debt-review] failed to record notice for loan ${id}`, failureSummary(error))
      return NextResponse.json({ error: "Failed to record the debt-review notice" }, { status: 500 })
    }
  })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const guard = await guardCollections()
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("Debt review (NCA s86)")
  if (notNca) return notNca
  const { user } = guard

  return await withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null) ?? {}) as Record<string, unknown>
    // The reason is the trail's only account of WHY dunning was allowed to resume.
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    if (!reason) return NextResponse.json({ error: "A reason is required" }, { status: 422 })
    if (reason.length > MAX_REASON) {
      return NextResponse.json({ error: `The reason is at most ${MAX_REASON} characters` }, { status: 422 })
    }

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await lockLoanForUpdate(tx, id)
        const loan = await tx.loan.findUnique({
          where: { id, tenantId: tenant.id },
          select: { id: true, debtReviewNoticeAt: true, debtReviewNoticeRef: true },
        })
        if (!loan) return "NOT_FOUND" as const
        if (!loan.debtReviewNoticeAt) return "NOTHING_TO_CLEAR" as const

        await tx.loan.update({
          where: { id, tenantId: tenant.id },
          data: { debtReviewNoticeAt: null, debtReviewNoticeRef: null },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.DEBT_REVIEW_NOTICE_CLEARED,
          entity: "Loan",
          entityId: id,
          oldValue: {
            debtReviewNoticeAt: sastCalendarDate(loan.debtReviewNoticeAt),
            debtReviewNoticeRef: loan.debtReviewNoticeRef,
          },
          newValue: { debtReviewNoticeAt: null, debtReviewNoticeRef: null, reason },
        }, tx)
        return "CLEARED" as const
      })

      if (outcome === "NOT_FOUND") return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      if (outcome === "NOTHING_TO_CLEAR") {
        return NextResponse.json({ error: "No debt-review notice is recorded on this loan." }, { status: 409 })
      }
      return NextResponse.json({ debtReviewNoticeAt: null, debtReviewNoticeRef: null })
    } catch (error) {
      console.error(`[debt-review] failed to clear notice for loan ${id}`, failureSummary(error))
      return NextResponse.json({ error: "Failed to clear the debt-review notice" }, { status: 500 })
    }
  })
}
