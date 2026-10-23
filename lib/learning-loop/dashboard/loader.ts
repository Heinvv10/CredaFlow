/**
 * Loads one lender's decision-performance dashboard (DESIGN.md §6). Every read
 * runs inside that lender's tenant frame AND names its tenantId, so the
 * tenant-scope extension (and RLS, where on) confines it to the lender; the
 * operator console reads none of this. The aggregation is the pure code
 * beside this file.
 */
import { sastCalendarDate } from "@/lib/date/sast"
import type { prisma } from "@/lib/prisma"
import { getBookArrears, type BookArrears } from "@/lib/reports/book-arrears"
import { runWithTenant } from "@/lib/tenant-scope"
import { addDays, addMonths, dayInstant } from "../outcomes/definition"
import {
  approvalCohorts, cohortTotals, NO_SCORE_BAND, overrideComparison,
  type ApprovalInput, type CohortCell, type CohortMetrics, type CohortWindow, type OverrideCell,
} from "./cohorts"
import {
  arrangementOutcomes, cureRollByStage, type ArrangementSummary, type HistoryDay, type LoanHistory, type StageCell,
} from "./collections"
import { declineVolume, offerTakeUp, type DeclineSummary, type TakeUpCell } from "./offers-declines"

export type DashboardDb = Pick<typeof prisma,
  "creditDecisionRecord" | "loanApplication" | "loan" | "loanArrearsSnapshot" | "paymentArrangement" | "tenantConfig">

export interface DecisionPerformance {
  /**
   * A synthetic demo lender (TenantConfig.isDemoLender): every figure is demo
   * data and the page labels it so. A real lender's figures read no row
   * marked demoData (DESIGN.md decision 4).
   */
  demoData: boolean
  window: CohortWindow
  /** SAST `yyyy-mm` of the first month read: decisions older than DECISION_LOOKBACK_MONTHS are not on the page. */
  since: string
  approvals: number
  totals: CohortMetrics
  cohorts: CohortCell[]
  overrides: OverrideCell[]
  takeUp: TakeUpCell[]
  declines: DeclineSummary
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

/**
 * How far back the page reads decisions (by decision date), counted in whole
 * SAST months before this one: a request reads a bounded slice, not the
 * lender's whole log. 24 months holds every cohort a 12-month window has
 * matured for, plus a year of them.
 */
export const DECISION_LOOKBACK_MONTHS = 24

/** An `id IN (…)` read in pieces, so a big book cannot reach the bind-variable limit. */
const IN_CHUNK = 1000
async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const pieces: string[][] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) pieces.push(ids.slice(i, i + IN_CHUNK))
  return (await Promise.all(pieces.map(read))).flat()
}

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
    const sinceDay = addMonths(`${today.slice(0, 7)}-01`, -DECISION_LOOKBACK_MONTHS)
    const decidedSince = { gte: dayInstant(sinceDay) }
    const historyFrom = new Date(`${addDays(today, -HISTORY_DAYS)}T00:00:00.000Z`)
    // Only a loan that was past due in the history can start an episode: the days of any other are not read.
    const lateLoanIds = (await db.loanArrearsSnapshot.groupBy({
      by: ["loanId"], where: { tenantId, snapshotDate: { gte: historyFrom }, daysInArrears: { gt: 0 } },
    })).map((g) => g.loanId)
    const [approvalRows, offerRows, declineRows, snapshots, arrangements, book] = await Promise.all([
      // Final approvals the outcome job attached loan outcomes to (an approval undone by a return gets none).
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "CREDIT_DECISION", decision: "APPROVE", decidedAt: decidedSince, outcomes: { some: { demoData } } },
        select: {
          id: true, applicationId: true, decidedAt: true, ruleVersion: true, policyHash: true, overridden: true, inputsSnapshot: true,
          outcomes: { where: { window, demoData }, select: OUTCOME_SELECT },
        },
      }),
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "OFFER", decidedAt: decidedSince },
        select: { decision: true, decidedAt: true, outcomes: { where: { outcomeKind: "TAKEN_UP", demoData }, select: OUTCOME_SELECT } },
      }),
      db.creditDecisionRecord.findMany({
        where: { tenantId, kind: "CREDIT_DECISION", decision: "DECLINE", decidedAt: decidedSince },
        select: { decidedAt: true, actorType: true, s71ReviewRequired: true, inputsSnapshot: true },
      }),
      inChunks(lateLoanIds, (ids) => db.loanArrearsSnapshot.findMany({
        where: { tenantId, loanId: { in: ids }, snapshotDate: { gte: historyFrom } },
        select: { loanId: true, snapshotDate: true, daysInArrears: true, collectionsStage: true },
      })),
      db.paymentArrangement.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
      getBookArrears(tenantId, "ALL", db),
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
    const loanEnds = await inChunks(loanIds, (ids) => db.loan.findMany({
      where: { tenantId, id: { in: ids } }, select: { id: true, status: true, closedAt: true, writeOffAt: true },
    }))
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
      since: sinceDay.slice(0, 7),
      approvals: approvals.length,
      totals: cohortTotals(approvals, window),
      cohorts: approvalCohorts(approvals, window),
      overrides: overrideComparison(approvals, window),
      takeUp: offerTakeUp(offerRows.map((o) => ({ month: month(o.decidedAt), decision: o.decision, outcomes: o.outcomes }))),
      declines: declineVolume(declineRows.map((d) => ({
        month: month(d.decidedAt), category: snapshotField(d.inputsSnapshot, "declineCategory"), actorType: d.actorType,
        refusalReason: snapshotField(d.inputsSnapshot, "refusalReason"), s71ReviewRequired: d.s71ReviewRequired,
      }))),
      stages: cureRollByStage(histories, today),
      arrangements: arrangementOutcomes(Object.fromEntries(arrangements.map((a) => [a.status, a._count._all]))),
      book,
    }
  })
}
