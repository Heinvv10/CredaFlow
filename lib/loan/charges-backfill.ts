import type { prisma } from "@/lib/prisma"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { AuditAction } from "@/lib/audit"
import { chargesOutstandingTotal, loadChargesReplay } from "@/lib/loan/charges-replay"
import { guardedChanges, reallocatesInstalments, syncRefusal, type AcceptanceChange } from "@/lib/loan/charges-verdict"
import { sweepLoanIds, sweepTenantCharges, type SweepResult } from "@/lib/loan/charges-sweep"
import { sastCalendarDay } from "@/lib/loan/settlement"
import { goLiveInputs, stampUnfrozenNotices, switchChargesOn, unfrozenNotices } from "@/lib/loan/charges-switch"

export { disableCharges } from "@/lib/loan/charges-switch"

// Back-fill of default charges onto an existing book (scripts/default-charges-backfill.ts).
// ALL money is CENTS. The dry run is a pure read of exactly what --apply will
// write; --apply is the same sweep the nightly cron runs, attributed to a person.

export type BackfillDb = Pick<
  typeof prisma,
  "$transaction" | "loan" | "tenantConfig" | "payment" | "complianceRecord" | "loanCharge" | "repaymentSchedule" | "auditLog"
>

export interface BackfillRow {
  /** id prefix, enough to find the loan without printing a full identifier list */
  loan: string
  product: string
  daysOverdue: number
  overduePrincipal: number
  defaultInterest: number
  serviceFees: number
  letterCharges: number
  /** charges the replay leaves unpaid */
  chargesOutstanding: number
  /** Loan.totalPaid now, and the schedule share the replay would leave */
  totalPaidBefore: number
  totalPaidAfter: number
  inDuplum: { capBase: number; accrued: number; reached: boolean } | null
  /** receipts beyond everything owed: --apply would refuse this loan */
  unallocated: number
}

/** A loan whose stored ledger disagrees with itself; --apply refuses while any exist. */
export interface LedgerMismatch {
  loanId: string
  /** SUM(RepaymentSchedule.totalPaid) */
  scheduleTotalPaid: number
  loanTotalPaid: number
  /** SUM(amount - charge splits) over live allocated receipts */
  receiptsScheduleShare: number
}

/**
 * The identity every collectible loan must satisfy before charges are applied:
 * SUM(schedule.totalPaid) = Loan.totalPaid = SUM(live allocated receipt amount
 * - charge splits). A loan failing it would be re-derived from receipts the
 * rest of the system never counted.
 */
export async function ledgerMismatches(db: BackfillDb, tenantId: string): Promise<LedgerMismatch[]> {
  // Every loan --apply re-derives.
  const ids = await sweepLoanIds(db, tenantId)
  const loans = await db.loan.findMany({
    where: { tenantId, id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true, totalPaid: true },
  })
  const [schedule, receipts] = await Promise.all([
    db.repaymentSchedule.groupBy({
      by: ["loanId"], where: { tenantId, loanId: { in: ids } }, _sum: { totalPaid: true },
    }),
    db.payment.groupBy({
      by: ["loanId"],
      where: { tenantId, loanId: { in: ids }, reversed: false, allocationStatus: "ALLOCATED" },
      _sum: { amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true },
    }),
  ])
  const scheduleByLoan = new Map(schedule.map((row) => [row.loanId, row._sum.totalPaid ?? 0]))
  const receiptsByLoan = new Map(receipts.map((row) => [
    row.loanId,
    (row._sum.amount ?? 0) - (row._sum.defaultInterestAllocated ?? 0) - (row._sum.chargeFeesAllocated ?? 0),
  ]))
  return loans
    .map((loan) => ({
      loanId: loan.id,
      scheduleTotalPaid: scheduleByLoan.get(loan.id) ?? 0,
      loanTotalPaid: loan.totalPaid,
      receiptsScheduleShare: receiptsByLoan.get(loan.id) ?? 0,
    }))
    .filter((m) => m.scheduleTotalPaid !== m.loanTotalPaid || m.loanTotalPaid !== m.receiptsScheduleShare)
}

/**
 * A loan --apply would change in a way a normal sync refuses — lower its
 * Loan.totalPaid (move money booked to the instalments onto charges) or
 * re-open it though settled — or whose booked split between instalments
 * s126(3) changes (reallocatesInstalments). Staff must resolve it first:
 * exempt it (which refunds charge money and keeps the booked order) or accept
 * it (--accept, audited).
 */
export interface NeedsAcceptance {
  loanId: string
  changes: AcceptanceChange[]
  totalPaidBefore: number
  totalPaidAfter: number
  /** charges and schedule the replay says are still owed */
  chargesOutstanding: number
  scheduleOutstanding: number
}

export interface BackfillPlan {
  rows: BackfillRow[]
  total: { goLive: string; loans: number; defaultInterest: number; serviceFees: number; letterCharges: number; charges: number }
  mismatches: LedgerMismatch[]
  /** issued notices --apply would freeze today's admin charge onto */
  noticesToStamp: Array<{ noticeId: string; loanId: string | null }>
  /** loans the sweep would refuse, with why */
  wouldFail: Array<{ loanId: string; error: string }>
  needsAcceptance: NeedsAcceptance[]
}

/**
 * Exactly what --apply will write: every loan it sweeps, replayed with the
 * inputs it switches the tenant to (goLiveInputs — go-live, unfrozen notices
 * at the amount it stamps), and judged as the sync judges it. Read-only.
 * Refuses (ChargesStopped) once charges were stopped for the tenant.
 */
export async function planChargesBackfill(db: BackfillDb, tenantId: string, asOf: Date): Promise<BackfillPlan> {
  const inputs = await goLiveInputs(db, tenantId, asOf)
  const ids = await sweepLoanIds(db, tenantId)
  const rows: BackfillRow[] = []
  const wouldFail: BackfillPlan["wouldFail"] = []
  const needsAcceptance: NeedsAcceptance[] = []
  for (const id of ids) {
    let replay
    try {
      replay = await loadChargesReplay(db, { tenantId, loanId: id }, asOf, { preview: inputs, decidingStatus: true })
    } catch (error) {
      wouldFail.push({ loanId: id, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!replay) throw new Error(`Tenant ${tenantId} has no TenantConfig; nothing to preview`)
    const { loan, result } = replay
    const refusal = syncRefusal(id, loan, result)
    if (refusal) wouldFail.push({ loanId: id, error: refusal })
    const changes: AcceptanceChange[] = guardedChanges(loan, result)
    if (reallocatesInstalments(loan.repaymentSchedule, result)) changes.push("reallocates_instalments")
    if (changes.length > 0 && !refusal) {
      const scheduleTotal = loan.repaymentSchedule.reduce((sum, row) => sum + row.totalDue, 0)
      needsAcceptance.push({
        loanId: id,
        changes,
        totalPaidBefore: loan.totalPaid,
        totalPaidAfter: result.scheduleAllocated,
        chargesOutstanding: chargesOutstandingTotal(result),
        scheduleOutstanding: scheduleTotal - result.scheduleAllocated,
      })
    }
    const sum = (type: string) => result.postings
      .filter((posting) => posting.type === type)
      .reduce((total, posting) => total + posting.amount, 0)
    const postRows = loan.repaymentSchedule.map((row, i) => ({ ...row, totalPaid: result.scheduleRows[i].paid }))
    const today = sastCalendarDay(asOf)
    rows.push({
      loan: id.slice(0, 12),
      product: loan.product.code,
      daysOverdue: recomputeLoanBalances(loan.principal, postRows, asOf).daysInArrears,
      overduePrincipal: postRows
        .filter((row) => sastCalendarDay(row.dueDate) < today)
        .reduce((total, row) => total + Math.min(row.principalDue, Math.max(0, row.totalDue - row.totalPaid)), 0),
      defaultInterest: result.interestAccrued,
      serviceFees: sum("SERVICE_FEE"),
      letterCharges: sum("DEFAULT_ADMIN"),
      chargesOutstanding: chargesOutstandingTotal(result),
      totalPaidBefore: loan.totalPaid,
      totalPaidAfter: result.scheduleAllocated,
      inDuplum: result.inDuplum,
      unallocated: result.unallocated,
    })
  }
  const add = (key: "defaultInterest" | "serviceFees" | "letterCharges") =>
    rows.reduce((total, row) => total + row[key], 0)
  const total = {
    goLive: inputs.startedAt.toISOString(),
    loans: rows.length,
    defaultInterest: add("defaultInterest"),
    serviceFees: add("serviceFees"),
    letterCharges: add("letterCharges"),
    charges: add("defaultInterest") + add("serviceFees") + add("letterCharges"),
  }
  return {
    rows, total, wouldFail, needsAcceptance,
    mismatches: await ledgerMismatches(db, tenantId),
    noticesToStamp: (await unfrozenNotices(db, tenantId)).map((n) => ({ noticeId: n.id, loanId: n.referenceId })),
  }
}

/**
 * Posts the back-fill. First plans it (planChargesBackfill) and refuses,
 * writing nothing — no flag, go-live or stamp — while charges were stopped, any loan
 * fails the ledger identity, any loan would fail the sweep, or any loan needs
 * acceptance that staff have not given (`accept`, audited per loan). Otherwise,
 * in one audited transaction, stamps unfrozen notices and switches charges on
 * to the planned inputs; then sweeps with exactly the accepted set, so a
 * receipt landing after the plan cannot slip a loan through unaccepted.
 */
export async function applyChargesBackfill(
  db: BackfillDb,
  tenantId: string,
  asOf: Date,
  actor: { userId: string; userEmail: string },
  { accept = [] }: { accept?: string[] } = {},
): Promise<SweepResult> {
  const plan = await planChargesBackfill(db, tenantId, asOf)
  const refuse = (why: string) => { throw new Error(`Refusing to apply: ${why}`) }
  if (plan.mismatches.length > 0) {
    refuse(`${plan.mismatches.length} loan(s) fail SUM(schedule.totalPaid) = Loan.totalPaid = `
      + `SUM(receipts - charge splits): ${plan.mismatches.map((m) => m.loanId).join(", ")}`)
  }
  if (plan.wouldFail.length > 0) {
    refuse(`${plan.wouldFail.length} loan(s) would fail the sweep: ${plan.wouldFail.map((f) => `${f.loanId} (${f.error})`).join("; ")}`)
  }
  const accepted = new Set(accept)
  const listed = new Set(plan.needsAcceptance.map((n) => n.loanId))
  const unknown = accept.filter((id) => !listed.has(id))
  if (unknown.length > 0) refuse(`--accept names loan(s) the apply would not need accepted: ${unknown.join(", ")}`)
  const unresolved = plan.needsAcceptance.filter((n) => !accepted.has(n.loanId))
  if (unresolved.length > 0) {
    refuse(`${unresolved.length} loan(s) need acceptance; exempt each or pass --accept: `
      + unresolved.map((n) => `${n.loanId} (${n.changes.join(", ")}; totalPaid ${n.totalPaidBefore} -> ${n.totalPaidAfter}, `
        + `charges owed ${n.chargesOutstanding}, schedule owed ${n.scheduleOutstanding})`).join("; "))
  }
  await db.$transaction(async (tx) => {
    const inputs = await goLiveInputs(tx, tenantId, asOf)
    await stampUnfrozenNotices(tx, tenantId, inputs, actor)
    await switchChargesOn(tx, tenantId, inputs, actor)
    for (const change of plan.needsAcceptance) {
      await tx.auditLog.create({
        data: {
          tenantId, userId: actor.userId, userEmail: actor.userEmail,
          action: AuditAction.DEFAULT_CHARGES_CHANGE_ACCEPTED, entity: "Loan", entityId: change.loanId,
          newValue: { ...change, source: "backfill" },
        },
      })
    }
  })
  return await sweepTenantCharges(db, tenantId, asOf, { source: "backfill", ...actor }, { accepted })
}
