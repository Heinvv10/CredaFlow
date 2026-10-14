/**
 * Plans collection instructions for every ACTIVE mandate of a tenant from its
 * loan's instalment schedule (planInstructions), and writes them PENDING.
 *
 * Duplicates are impossible rather than avoided: the partial unique indexes
 * allow one in-flight instruction per instalment and each presentment number
 * once per mandate, and the AFTER INSERT trigger refuses any instruction on a
 * mandate that is not ACTIVE. A concurrent run's insert is skipped, not retried.
 */
import { createHash } from "node:crypto"
import type { CollectionReasonCode } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { planInstructions, type PlanRow } from "./schedule"
import { ENGINE_ACTOR, dateOnly, dayOf, isUniqueViolation, type EngineContext } from "./context"

export interface PlanSummary {
  mandates: number
  planned: number
  skipped: number
}

/** Stable per presentment and action date; short and alphanumeric, as payment rails require. */
export function instructionRef(mandateId: string, scheduleId: string, presentmentNo: number, actionDate: string): string {
  const digest = createHash("sha256").update(`${mandateId}:${scheduleId}:${presentmentNo}:${actionDate}`).digest("hex")
  return `CI${digest.slice(0, 18).toUpperCase()}`
}

export async function planTenantInstructions(ctx: EngineContext): Promise<PlanSummary> {
  const today = sastCalendarDate(ctx.now)
  const mandates = await prisma.debitMandate.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, status: "ACTIVE", loan: { status: { in: ["ACTIVE", "DEFAULTED"] } } },
    select: {
      id: true, loanId: true, debitDay: true, maxAmountCents: true, trackingDays: true, firstCollectionDate: true,
      loan: { select: { repaymentSchedule: { select: { id: true, installmentNo: true, dueDate: true, totalDue: true, totalPaid: true, status: true } } } },
      instructions: {
        select: {
          repaymentScheduleId: true, presentmentNo: true, status: true,
          results: { select: { reasonCode: true, resolvedAt: true }, orderBy: { resolvedAt: "desc" }, take: 1 },
        },
      },
    },
  })
  const summary: PlanSummary = { mandates: mandates.length, planned: 0, skipped: 0 }

  for (const m of mandates) {
    const rows: PlanRow[] = m.loan.repaymentSchedule.map((r) => {
      const mine = m.instructions.filter((i) => i.repaymentScheduleId === r.id)
      const resolved = mine.flatMap((i) => i.results.map((x) => x.resolvedAt)).sort((a, b) => b.getTime() - a.getTime())
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
          reasonCode: (i.results[0]?.reasonCode ?? null) as CollectionReasonCode | null,
        })),
        lastResolvedOn: resolved[0] ? sastCalendarDate(resolved[0]) : null,
      }
    })
    const drafts = planInstructions({
      mandate: { debitDay: m.debitDay, maxAmountCents: m.maxAmountCents, firstCollectionDate: dayOf(m.firstCollectionDate) },
      today,
      rows,
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
        if (!isUniqueViolation(error)) throw error
        summary.skipped++
      }
    }
  }
  return summary
}
