/**
 * Plans collection instructions for every ACTIVE mandate of a tenant from its
 * loan's instalment schedule (planInstructions), and writes them PENDING.
 *
 * Before planning, the scheme stop rules are re-applied to the mandate, so a
 * suspension a failed run never wrote cannot be planned past. Presentments are
 * counted per instalment across every mandate of the loan (no reset on a
 * fresh mandate), and one mandate's debits on one date never exceed its
 * maximum. The database refuses duplicates and anything on a mandate that is
 * not ACTIVE; a concurrent run's insert is skipped. One failing mandate or
 * insert is recorded and the rest of the tenant is still planned.
 */
import { createHash } from "node:crypto"
import type { CollectionReasonCode } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { COLLECTIBLE_LOAN_STATUSES } from "./scheme-rules"
import { planInstructions, type PlanRow } from "./schedule"
import { applyStopRules } from "./stop-rules"
import { ENGINE_ACTOR, dateOnly, dayOf, errorSummary, isUniqueViolation, type EngineContext } from "./context"

export interface PlanSummary {
  mandates: number
  planned: number
  skipped: number
  suspended: number
  errors: string[]
}

/** Stable per presentment and action date; short and alphanumeric, as payment rails require. */
export function instructionRef(mandateId: string, scheduleId: string, presentmentNo: number, actionDate: string): string {
  const digest = createHash("sha256").update(`${mandateId}:${scheduleId}:${presentmentNo}:${actionDate}`).digest("hex")
  return `CI${digest.slice(0, 18).toUpperCase()}`
}

const NOT_COMMITTED = new Set(["CANCELLED", "REJECTED"])

async function planMandate(ctx: EngineContext, mandateId: string, today: string, summary: PlanSummary): Promise<void> {
  if (await applyStopRules(ctx, mandateId)) {
    summary.suspended++
    return
  }
  const m = await prisma.debitMandate.findFirst({
    where: { id: mandateId, tenantId: ctx.tenantId, status: "ACTIVE", loan: { status: { in: [...COLLECTIBLE_LOAN_STATUSES] } } },
    select: {
      id: true, loanId: true, debitDay: true, maxAmountCents: true, trackingDays: true, firstCollectionDate: true,
      loan: {
        select: {
          repaymentSchedule: { select: { id: true, installmentNo: true, dueDate: true, totalDue: true, totalPaid: true, status: true } },
          // Every mandate's instructions on this loan: the presentment cap is per instalment.
          collectionInstructions: {
            select: {
              mandateId: true, repaymentScheduleId: true, presentmentNo: true, status: true, actionDate: true, amountCents: true,
              results: { select: { reasonCode: true, resolvedAt: true, reportedAfterPayment: true }, orderBy: { resolvedAt: "desc" } },
            },
          },
        },
      },
    },
  })
  if (!m) return
  const all = m.loan.collectionInstructions
  const committedByDate = new Map<string, number>()
  for (const i of all) {
    if (i.mandateId !== m.id || NOT_COMMITTED.has(i.status)) continue
    committedByDate.set(dayOf(i.actionDate), (committedByDate.get(dayOf(i.actionDate)) ?? 0) + i.amountCents)
  }
  const rows: PlanRow[] = m.loan.repaymentSchedule.map((r) => {
    const mine = all.filter((i) => i.repaymentScheduleId === r.id)
    const results = mine.flatMap((i) => i.results.filter((x) => !x.reportedAfterPayment))
    const resolved = results.map((x) => x.resolvedAt).sort((a, b) => b.getTime() - a.getTime())
    return {
      id: r.id,
      installmentNo: r.installmentNo,
      dueOn: sastCalendarDate(r.dueDate),
      totalDue: r.totalDue,
      totalPaid: r.totalPaid,
      status: r.status,
      presentments: mine.map((i) => ({
        presentmentNo: i.presentmentNo,
        status: i.status,
        reasonCode: (i.results.find((x) => !x.reportedAfterPayment)?.reasonCode ?? null) as CollectionReasonCode | null,
      })),
      lastResolvedOn: resolved[0] ? sastCalendarDate(resolved[0]) : null,
    }
  })
  const drafts = planInstructions({
    mandate: { debitDay: m.debitDay, maxAmountCents: m.maxAmountCents, firstCollectionDate: dayOf(m.firstCollectionDate) },
    today,
    rows,
    committedByDate,
  })
  for (const d of drafts) {
    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.collectionInstruction.create({
          data: {
            tenantId: ctx.tenantId, mandateId: m.id, loanId: m.loanId, repaymentScheduleId: d.repaymentScheduleId,
            installmentNo: d.installmentNo, presentmentNo: d.presentmentNo, amountCents: d.amountCents,
            actionDate: dateOnly(d.actionDate), trackingDays: m.trackingDays,
            instructionRef: instructionRef(m.id, d.repaymentScheduleId, d.presentmentNo, d.actionDate),
          },
        })
        await logAuditStrict({
          tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
          action: AuditAction.COLLECTION_INSTRUCTION_PLANNED, entity: "CollectionInstruction", entityId: created.id,
          newValue: { mandateId: m.id, loanId: m.loanId, ...d },
        }, tx)
      })
      summary.planned++
    } catch (error) {
      if (isUniqueViolation(error)) summary.skipped++
      else summary.errors.push(`${m.id}/${d.repaymentScheduleId}: ${errorSummary(error)}`)
    }
  }
}

export async function planTenantInstructions(ctx: EngineContext): Promise<PlanSummary> {
  const today = sastCalendarDate(ctx.now)
  const mandates = await prisma.debitMandate.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, status: "ACTIVE", loan: { status: { in: [...COLLECTIBLE_LOAN_STATUSES] } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  })
  const summary: PlanSummary = { mandates: mandates.length, planned: 0, skipped: 0, suspended: 0, errors: [] }
  for (const { id } of mandates) {
    try {
      await planMandate(ctx, id, today, summary)
    } catch (error) {
      summary.errors.push(`${id}: ${errorSummary(error)}`)
    }
  }
  return summary
}
