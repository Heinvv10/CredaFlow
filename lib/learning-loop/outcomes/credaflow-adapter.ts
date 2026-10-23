/**
 * CredaFlow's own servicing tables as an outcome source (DESIGN.md §3):
 * RepaymentSchedule (paidAt), LoanArrearsSnapshot (daily DPD and status),
 * CollectionResult (returned debit orders), Loan (how it ended),
 * LoanApplication (take-up) and ArrearsSnapshotRun (which nights the lender's
 * book was recorded at all). Runs inside the job's tenant frame, so the
 * tenant-scope extension and RLS confine every read to one lender.
 *
 * Bounded reads: the decision records are paged, a loan finalised by an
 * earlier run is not derived again (./finalized.ts), and the arrears history
 * of the rest is read from the earliest window start of its chunk on.
 *
 * A simulated collection result (no bank ever saw it) counts
 * as a returned debit order only for a demo lender (TenantConfig.isDemoLender,
 * DESIGN.md decision 4); a real lender's outcomes never include one, whatever
 * the deployment's DEMO_MODE.
 */
import type { CollectionReasonCode, LoanStatus } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import type { prisma } from "@/lib/prisma"
import type { AdapterContext, AdapterResult, OutcomeSourceAdapter } from "./adapter"
import { finalApproval, takeUpOutcomes, type DecisionRef } from "./attribution"
import { MONTH_WINDOWS, addMonths } from "./definition"
import { deriveLoanOutcomes } from "./derive"
import type { LoanEnd, LoanFacts } from "./facts"
import { finalizedApprovals } from "./finalized"

export type CredaflowOutcomeDb = Pick<typeof prisma,
  "creditDecisionRecord" | "loan" | "loanApplication" | "loanArrearsSnapshot" | "collectionResult" | "arrearsSnapshotRun" | "decisionOutcome">

const CHUNK = 200
const RECORD_PAGE = 5000
const LONGEST_WINDOW_MONTHS = Math.max(...MONTH_WINDOWS.map((w) => w.months))

function loanEnd(status: LoanStatus, closedAt: Date | null, writeOffAt: Date | null): LoanEnd {
  const day = (d: Date | null) => (d ? sastCalendarDate(d) : null)
  if (status === "COMPLETED") return { kind: "SETTLED", day: day(closedAt) }
  if (status === "WRITTEN_OFF") return { kind: "WRITTEN_OFF", day: day(writeOffAt ?? closedAt) }
  if (status === "CANCELLED") return { kind: "CANCELLED", day: day(closedAt) }
  return { kind: "OPEN" }
}

/** Every credit decision and offer that names an application, by application; read a page at a time. */
async function loadDecisionRefs(db: CredaflowOutcomeDb, tenantId: string): Promise<Map<string, DecisionRef[]>> {
  const byApplication = new Map<string, DecisionRef[]>()
  for (let after: string | undefined; ;) {
    const page = await db.creditDecisionRecord.findMany({
      where: { tenantId, kind: { in: ["CREDIT_DECISION", "OFFER"] }, applicationId: { not: null } },
      select: { id: true, kind: true, decision: true, applicationId: true, decidedAt: true, createdAt: true },
      orderBy: { id: "asc" }, take: RECORD_PAGE, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    })
    for (const r of page) {
      const ref = { ...r, applicationId: r.applicationId as string }
      const list = byApplication.get(ref.applicationId)
      if (list) list.push(ref)
      else byApplication.set(ref.applicationId, [ref])
    }
    if (page.length < RECORD_PAGE) return byApplication
    after = page[page.length - 1].id
  }
}

/** What deciding whether a loan needs deriving takes: no schedule, no arrears history. */
async function loadChunk(db: CredaflowOutcomeDb, applicationIds: string[], demoTenant: boolean) {
  const [applications, loans] = await Promise.all([
    db.loanApplication.findMany({ where: { id: { in: applicationIds } }, select: { id: true, status: true, disbursedAt: true, updatedAt: true } }),
    db.loan.findMany({
      where: { applicationId: { in: applicationIds } },
      select: { id: true, applicationId: true, status: true, maturityDate: true, closedAt: true, writeOffAt: true, createdAt: true },
    }),
  ])
  const returns = await db.collectionResult.findMany({
    where: {
      outcome: "UNPAID", reportedAfterPayment: false,
      instruction: { loanId: { in: loans.map((l) => l.id) } },
      ...(demoTenant ? {} : { simulated: false }),
    },
    select: { id: true, reasonCode: true, resolvedAt: true, instruction: { select: { loanId: true, installmentNo: true, amountCents: true } } },
  })
  return { applications, loans, returns: groupBy(returns, (r) => r.instruction.loanId) }
}

type Chunk = Awaited<ReturnType<typeof loadChunk>>

/** The instalments, and the arrears history from the earliest window start among these loans (no window reads before its first due day). */
async function loadScheduleAndHistory(db: CredaflowOutcomeDb, loanIds: string[]) {
  const loans = await db.loan.findMany({
    where: { id: { in: loanIds } },
    select: {
      id: true,
      repaymentSchedule: {
        where: { status: { not: "CANCELLED" }, totalDue: { gt: 0 } },
        orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
        select: { id: true, installmentNo: true, dueDate: true, totalDue: true, totalPaid: true, paidAt: true },
      },
    },
  })
  const firstDays = loans.flatMap((l) => (l.repaymentSchedule[0] ? [sastCalendarDate(l.repaymentSchedule[0].dueDate)] : []))
  // No window ends after its 12M end, so no snapshot after the chunk's latest one is read.
  const earliestStart = [...firstDays].sort().at(0)
  const lastWindowEnd = firstDays.map((d) => addMonths(d, LONGEST_WINDOW_MONTHS)).sort().at(-1)
  const snapshots = earliestStart && lastWindowEnd
    ? await db.loanArrearsSnapshot.findMany({
      where: {
        loanId: { in: loanIds },
        snapshotDate: { gte: new Date(`${earliestStart}T00:00:00.000Z`), lt: new Date(`${lastWindowEnd}T00:00:00.000Z`) },
      },
      select: { loanId: true, snapshotDate: true, daysInArrears: true, status: true },
    })
    : []
  return { schedules: new Map(loans.map((l) => [l.id, l.repaymentSchedule])), snapshots: groupBy(snapshots, (s) => s.loanId) }
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

type History = Awaited<ReturnType<typeof loadScheduleAndHistory>>

function loanFacts(loan: Chunk["loans"][number], chunk: Chunk, history: History, sourceRecordedDays: ReadonlySet<string>): LoanFacts {
  return {
    ref: loan.id,
    maturityDay: sastCalendarDate(loan.maturityDate),
    end: loanEnd(loan.status, loan.closedAt, loan.writeOffAt),
    instalments: (history.schedules.get(loan.id) ?? []).map((row) => {
      const paidInFull = row.totalPaid >= row.totalDue
      return {
        ref: row.id, installmentNo: row.installmentNo, dueDay: sastCalendarDate(row.dueDate), totalDueCents: row.totalDue,
        paidInFull, paidDay: paidInFull && row.paidAt ? sastCalendarDate(row.paidAt) : null,
      }
    }),
    // The DATE column is UTC midnight of the SAST day it describes.
    arrearsHistory: (history.snapshots.get(loan.id) ?? []).map((s) => ({
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
    async derive({ tenantId, today, demoTenant }: AdapterContext): Promise<AdapterResult> {
      const runs = await db.arrearsSnapshotRun.findMany({ where: { tenantId }, select: { snapshotDate: true } })
      const recordedDays = new Set(runs.map((r) => r.snapshotDate.toISOString().slice(0, 10)))
      const byApplication = await loadDecisionRefs(db, tenantId)
      const skipped: string[] = []
      const result: AdapterResult = { outcomes: [], decisionRecordIds: [], failures: [], skippedDecisionRecordIds: skipped }
      const applicationIds = [...byApplication.keys()].sort()
      for (let i = 0; i < applicationIds.length; i += CHUNK) {
        const chunk = await loadChunk(db, applicationIds.slice(i, i + CHUNK), demoTenant)
        const loanByApplication = new Map(chunk.loans.map((l) => [l.applicationId, l]))
        const loanApprovals: Array<{ loan: Chunk["loans"][number]; approval: DecisionRef }> = []
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
          if (approval) loanApprovals.push({ loan, approval })
        }
        const finalized = await finalizedApprovals(db, {
          tenantId, demoTenant,
          candidates: loanApprovals
            .filter(({ loan }) => loanEnd(loan.status, loan.closedAt, loan.writeOffAt).kind !== "OPEN")
            .map(({ loan, approval }) => ({ approvalId: approval.id, returns: chunk.returns.get(loan.id)?.length ?? 0 })),
        })
        const todo = loanApprovals.filter(({ approval }) => !finalized.has(approval.id))
        skipped.push(...finalized)
        if (todo.length === 0) continue
        const history = await loadScheduleAndHistory(db, todo.map(({ loan }) => loan.id))
        for (const { loan, approval } of todo) {
          try {
            result.outcomes.push(...deriveLoanOutcomes(approval.id, loanFacts(loan, chunk, history, recordedDays), today))
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
