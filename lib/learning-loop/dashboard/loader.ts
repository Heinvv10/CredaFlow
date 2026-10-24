/**
 * Loads one lender's decision-performance dashboard (DESIGN.md §6). Every read
 * runs inside that lender's tenant frame AND names its tenantId, so the
 * tenant-scope extension (and RLS, where on) confines it to the lender; the
 * operator console reads none of this. The aggregation is the pure code
 * beside this file.
 */
import { AuditAction } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import type { prisma } from "@/lib/prisma"
import { getBookArrears, type BookArrears } from "@/lib/reports/book-arrears"
import { runWithTenant } from "@/lib/tenant-scope"
import { addDays } from "../outcomes/definition"
import {
  approvalCohorts, cohortTotals, NO_SCORE_BAND, overrideComparison,
  type ApprovalInput, type CohortCell, type CohortMetrics, type CohortWindow, type OverrideCell,
} from "./cohorts"
import {
  arrangementOutcomes, cureRollByStage, type ArrangementSummary, type HistoryDay, type LoanHistory, type StageCell,
} from "./collections"
import { declineVolume, offerTakeUp, type DeclineSummary, type TakeUpCell } from "./offers-declines"

export type DashboardDb = Pick<typeof prisma,
  "auditLog" | "creditDecisionRecord" | "loanApplication" | "loan" | "loanArrearsSnapshot" | "paymentArrangement" | "tenantConfig">

export interface DecisionPerformance {
  /**
   * A synthetic demo lender (TenantConfig.isDemoLender): every figure is demo
   * data and the page labels it so. A real lender's figures read no row
   * marked demoData (DESIGN.md decision 4).
   */
  demoData: boolean
  window: CohortWindow
  approvals: number
  totals: CohortMetrics
  cohorts: CohortCell[]
  overrides: OverrideCell[]
  takeUp: TakeUpCell[]
  declines: DeclineSummary
  /** Automated refusals whose decision record failed to write (the refusal itself stood); counted from the audit trail. */
  refusalRecordFailures: number
  stages: StageCell[]
  arrangements: ArrangementSummary
  /** The collectible book now, by the board pack's own definitions (lib/reports/book-arrears.ts). */
  book: BookArrears
}

/**
 * How much arrears history the collections panel reads: a year of episodes
 * plus their horizon, and one day more (the first day read starts no episode).
 */
const HISTORY_DAYS = 401

const month = (d: Date) => sastCalendarDate(d).slice(0, 7)
const OUTCOME_SELECT = { outcomeKind: true, window: true, state: true, value: true, reasonCode: true } as const

function snapshotField(snapshot: unknown, ...path: string[]): string | null {
  let node: unknown = snapshot
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === "string" ? node : null
}

export function loadDecisionPerformance(db: DashboardDb, tenantId: string, asOf: Date, window: CohortWindow): Promise<DecisionPerformance> {
  return runWithTenant(tenantId, async () => {
    const today = sastCalendarDate(asOf)
    // Outcome rows are read only where demoData matches the lender: never demo and real in one figure.
    const demoData = (await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }))?.isDemoLender === true
    const [approvalRows, offerRows, declineRows, snapshots, arrangements, book, refusalRecordFailures] = await Promise.all([
      // Final approvals the outcome job attached loan outcomes to (an approval undone by a return gets none).
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "CREDIT_DECISION", decision: "APPROVE", outcomes: { some: { demoData } } },
        select: {
          id: true, applicationId: true, decidedAt: true, ruleVersion: true, policyHash: true, overridden: true, inputsSnapshot: true,
          outcomes: { where: { window, demoData }, select: OUTCOME_SELECT },
        },
      }),
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "OFFER" },
        select: { decision: true, decidedAt: true, outcomes: { where: { outcomeKind: "TAKEN_UP", demoData }, select: OUTCOME_SELECT } },
      }),
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "CREDIT_DECISION", decision: "DECLINE" },
        select: { decidedAt: true, actorType: true, s71ReviewRequired: true, inputsSnapshot: true },
      }),
      db.loanArrearsSnapshot.findMany({
        where: { tenantId, snapshotDate: { gte: new Date(`${addDays(today, -HISTORY_DAYS)}T00:00:00.000Z`) } },
        select: { loanId: true, snapshotDate: true, daysInArrears: true, collectionsStage: true },
      }),
      db.paymentArrangement.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
      getBookArrears(tenantId, "ALL", db),
      db.auditLog.count({ where: { tenantId, action: AuditAction.DECISION_RECORD_WRITE_FAILED } }),
    ])

    // Disbursal month, as the outcome job dates the loan: LoanApplication.disbursedAt, else Loan.createdAt.
    const applicationIds = approvalRows.map((r) => r.applicationId).filter((id): id is string => id !== null)
    const [applications, loansByApplication] = await Promise.all([
      db.loanApplication.findMany({ where: { tenantId, id: { in: applicationIds } }, select: { id: true, disbursedAt: true } }),
      db.loan.findMany({ where: { tenantId, applicationId: { in: applicationIds } }, select: { applicationId: true, createdAt: true } }),
    ])
    const disbursedAt = new Map<string, Date>()
    for (const l of loansByApplication) disbursedAt.set(l.applicationId, l.createdAt)
    for (const a of applications) if (a.disbursedAt) disbursedAt.set(a.id, a.disbursedAt)

    const approvals: ApprovalInput[] = approvalRows.map((r) => ({
      decisionRecordId: r.id,
      // A record with no CredaFlow loan (an external extract) is dated by its decision.
      cohortMonth: month((r.applicationId && disbursedAt.get(r.applicationId)) || r.decidedAt),
      ruleVersion: r.ruleVersion,
      policyHash: r.policyHash,
      scoreBand: snapshotField(r.inputsSnapshot, "bureau", "scoreBand") ?? NO_SCORE_BAND,
      overridden: r.overridden,
      product: snapshotField(r.inputsSnapshot, "productType") ?? "UNKNOWN",
      outcomes: r.outcomes,
    }))

    const loanIds = [...new Set(snapshots.map((s) => s.loanId))]
    const loanEnds = await db.loan.findMany({
      where: { tenantId, id: { in: loanIds } }, select: { id: true, status: true, closedAt: true, writeOffAt: true },
    })
    const days = new Map<string, HistoryDay[]>()
    for (const s of snapshots) {
      const list = days.get(s.loanId) ?? []
      days.set(s.loanId, list)
      // The DATE column is UTC midnight of the SAST day it describes.
      list.push({ day: s.snapshotDate.toISOString().slice(0, 10), daysInArrears: s.daysInArrears, stage: s.collectionsStage })
    }
    const day = (d: Date | null) => (d ? sastCalendarDate(d) : null)
    const histories: LoanHistory[] = loanEnds.map((l) => ({
      loanId: l.id,
      days: days.get(l.id) ?? [],
      end: l.status === "COMPLETED" ? { kind: "SETTLED", day: day(l.closedAt) }
        : l.status === "WRITTEN_OFF" ? { kind: "WRITTEN_OFF", day: day(l.writeOffAt ?? l.closedAt) }
        : l.status === "CANCELLED" ? { kind: "CANCELLED", day: day(l.closedAt) }
        : { kind: "OPEN", day: null },
    }))

    return {
      demoData,
      window,
      approvals: approvals.length,
      totals: cohortTotals(approvals, window),
      cohorts: approvalCohorts(approvals, window),
      overrides: overrideComparison(approvals, window),
      takeUp: offerTakeUp(offerRows.map((o) => ({ month: month(o.decidedAt), decision: o.decision, outcomes: o.outcomes }))),
      declines: declineVolume(declineRows.map((d) => ({
        month: month(d.decidedAt), category: snapshotField(d.inputsSnapshot, "declineCategory"), actorType: d.actorType,
        refusalReason: snapshotField(d.inputsSnapshot, "refusalReason"), s71ReviewRequired: d.s71ReviewRequired,
      }))),
      refusalRecordFailures,
      stages: cureRollByStage(histories, today),
      arrangements: arrangementOutcomes(Object.fromEntries(arrangements.map((a) => [a.status, a._count._all]))),
      book,
    }
  })
}
