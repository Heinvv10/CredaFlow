/**
 * CredaFlow's own servicing tables as an outcome source (DESIGN.md §3):
 * RepaymentSchedule (paidAt), LoanArrearsSnapshot (daily DPD and status),
 * CollectionResult (returned debit orders), Loan (how it ended),
 * LoanApplication (take-up) and ArrearsSnapshotRun (which nights the lender's
 * book was recorded at all). Runs inside the job's tenant frame, so the
 * tenant-scope extension and RLS confine every read to one lender.
 *
 * A simulated collection result (no bank ever saw it) counts as a returned
 * debit order only on a demo deployment (DEMO_MODE).
 */
import type { CollectionReasonCode, LoanStatus } from "@prisma/client"
import { isDemoMode } from "@/lib/config/demo-mode"
import { sastCalendarDate } from "@/lib/date/sast"
import type { prisma } from "@/lib/prisma"
import type { AdapterContext, AdapterResult, OutcomeSourceAdapter } from "./adapter"
import { finalApproval, takeUpOutcomes, type DecisionRef } from "./attribution"
import { MONTH_WINDOWS, addMonths } from "./definition"
import { deriveLoanOutcomes } from "./derive"
import type { LoanEnd, LoanFacts } from "./facts"

export type CredaflowOutcomeDb = Pick<typeof prisma,
  "creditDecisionRecord" | "loan" | "loanApplication" | "loanArrearsSnapshot" | "collectionResult" | "arrearsSnapshotRun">

const CHUNK = 200
const LONGEST_WINDOW_MONTHS = Math.max(...MONTH_WINDOWS.map((w) => w.months))

function loanEnd(status: LoanStatus, closedAt: Date | null, writeOffAt: Date | null): LoanEnd {
  const day = (d: Date | null) => (d ? sastCalendarDate(d) : null)
  if (status === "COMPLETED") return { kind: "SETTLED", day: day(closedAt) }
  if (status === "WRITTEN_OFF") return { kind: "WRITTEN_OFF", day: day(writeOffAt ?? closedAt) }
  if (status === "CANCELLED") return { kind: "CANCELLED", day: day(closedAt) }
  return { kind: "OPEN" }
}

async function loadChunk(db: CredaflowOutcomeDb, applicationIds: string[]) {
  const [applications, loans] = await Promise.all([
    db.loanApplication.findMany({ where: { id: { in: applicationIds } }, select: { id: true, status: true, disbursedAt: true, updatedAt: true } }),
    db.loan.findMany({
      where: { applicationId: { in: applicationIds } },
      select: {
        id: true, applicationId: true, status: true, maturityDate: true, closedAt: true, writeOffAt: true, createdAt: true,
        repaymentSchedule: {
          where: { status: { not: "CANCELLED" }, totalDue: { gt: 0 } },
          orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
          select: { id: true, installmentNo: true, dueDate: true, totalDue: true, totalPaid: true, paidAt: true },
        },
      },
    }),
  ])
  const loanIds = loans.map((l) => l.id)
  // No window ends after its 12M end, so no snapshot after the chunk's latest one is read.
  const windowEnds = loans.flatMap((l) => (l.repaymentSchedule[0] ? [addMonths(sastCalendarDate(l.repaymentSchedule[0].dueDate), LONGEST_WINDOW_MONTHS)] : []))
  const lastWindowEnd = windowEnds.sort().at(-1)
  const [snapshots, returns] = await Promise.all([
    lastWindowEnd
      ? db.loanArrearsSnapshot.findMany({
        where: { loanId: { in: loanIds }, snapshotDate: { lt: new Date(`${lastWindowEnd}T00:00:00.000Z`) } },
        select: { loanId: true, snapshotDate: true, daysInArrears: true, status: true },
      })
      : Promise.resolve([]),
    db.collectionResult.findMany({
      where: {
        outcome: "UNPAID", reportedAfterPayment: false, instruction: { loanId: { in: loanIds } },
        ...(isDemoMode() ? {} : { simulated: false }),
      },
      select: { id: true, reasonCode: true, resolvedAt: true, instruction: { select: { loanId: true, installmentNo: true, amountCents: true } } },
    }),
  ])
  return { applications, loans, snapshots: groupBy(snapshots, (s) => s.loanId), returns: groupBy(returns, (r) => r.instruction.loanId) }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

type Chunk = Awaited<ReturnType<typeof loadChunk>>

function loanFacts(loan: Chunk["loans"][number], chunk: Chunk, sourceRecordedDays: ReadonlySet<string>): LoanFacts {
  return {
    ref: loan.id,
    maturityDay: sastCalendarDate(loan.maturityDate),
    end: loanEnd(loan.status, loan.closedAt, loan.writeOffAt),
    instalments: loan.repaymentSchedule.map((row) => {
      const paidInFull = row.totalPaid >= row.totalDue
      return {
        ref: row.id, installmentNo: row.installmentNo, dueDay: sastCalendarDate(row.dueDate), totalDueCents: row.totalDue,
        paidInFull, paidDay: paidInFull && row.paidAt ? sastCalendarDate(row.paidAt) : null,
      }
    }),
    // The DATE column is UTC midnight of the SAST day it describes.
    arrearsHistory: (chunk.snapshots.get(loan.id) ?? []).map((s) => ({
      day: s.snapshotDate.toISOString().slice(0, 10), daysInArrears: s.daysInArrears, defaulted: s.status === "DEFAULTED",
    })),
    sourceRecordedDays,
    returns: (chunk.returns.get(loan.id) ?? []).map((r) => ({
      ref: r.id, installmentNo: r.instruction.installmentNo, amountCents: r.instruction.amountCents,
      reasonCode: r.reasonCode satisfies CollectionReasonCode | null, resolvedAt: r.resolvedAt,
    })),
  }
}

export function credaflowOutcomeAdapter(db: CredaflowOutcomeDb): OutcomeSourceAdapter {
  return {
    sourceSystem: "credaflow",
    async derive({ tenantId, today }: AdapterContext): Promise<AdapterResult> {
      const runs = await db.arrearsSnapshotRun.findMany({ where: { tenantId }, select: { snapshotDate: true } })
      const recordedDays = new Set(runs.map((r) => r.snapshotDate.toISOString().slice(0, 10)))
      const records = await db.creditDecisionRecord.findMany({
        where: { kind: { in: ["CREDIT_DECISION", "OFFER"] }, applicationId: { not: null } },
        select: { id: true, kind: true, decision: true, applicationId: true, decidedAt: true, createdAt: true },
      })
      const byApplication = new Map<string, DecisionRef[]>()
      for (const r of records) {
        const ref = { ...r, applicationId: r.applicationId as string }
        const list = byApplication.get(ref.applicationId)
        if (list) list.push(ref)
        else byApplication.set(ref.applicationId, [ref])
      }
      const result: AdapterResult = { outcomes: [], decisionRecordIds: [], failures: [] }
      const applicationIds = [...byApplication.keys()].sort()
      for (let i = 0; i < applicationIds.length; i += CHUNK) {
        const chunk = await loadChunk(db, applicationIds.slice(i, i + CHUNK))
        const loanByApplication = new Map(chunk.loans.map((l) => [l.applicationId, l]))
        for (const app of chunk.applications) {
          const appRecords = byApplication.get(app.id) ?? []
          const loan = loanByApplication.get(app.id)
          // A loan with no disbursement stamp was still paid out: it exists.
          const disbursedAt = app.disbursedAt ?? loan?.createdAt ?? null
          const offers = takeUpOutcomes(appRecords, { ...app, disbursedAt })
          result.outcomes.push(...offers)
          result.decisionRecordIds.push(...offers.map((o) => o.decisionRecordId))
          if (!loan || !disbursedAt) continue
          const approval = finalApproval(appRecords, disbursedAt)
          if (!approval) continue
          try {
            result.outcomes.push(...deriveLoanOutcomes(approval.id, loanFacts(loan, chunk, recordedDays), today))
            result.decisionRecordIds.push(approval.id)
          } catch (error) {
            result.failures.push({ ref: loan.id, decisionRecordId: approval.id, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      return result
    },
  }
}
