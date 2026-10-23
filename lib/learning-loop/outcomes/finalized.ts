/**
 * Which loans the nightly job need not derive again (DESIGN.md §4). A loan is
 * finalised when it has ended (settled, written off or cancelled), its rows
 * for the approval are all in a state no later day can change, they carry the
 * current OUTCOME_DEFINITION_VERSION and this lender's demoData flag, and no
 * returned debit order exists that they do not hold exactly (same results,
 * reasons, amounts and times), and the loan row has not been edited since the
 * rows were last computed. Anything else, an open loan or a still-pending,
 * revisable or older-version row, is derived again, so a version bump
 * recomputes every row.
 *
 * Final means OBSERVED, or UNOBSERVABLE for a reason that is a fact of the
 * past: a history gap or outage (the history is never backfilled) or a
 * cancellation. A missing close date, paid-at or schedule can be corrected,
 * so those stay revisable.
 *
 * Limit: the guard on edits is Loan.updatedAt (closedAt, writeOffAt,
 * maturityDate, status). RepaymentSchedule and receipts carry no updatedAt, so
 * a schedule or paid-at correction that leaves the Loan row untouched is not
 * seen until the next OUTCOME_DEFINITION_VERSION bump.
 */
import type { prisma } from "@/lib/prisma"
import { OUTCOME_DEFINITION_VERSION, UNOBSERVABLE_REASONS } from "./definition"

export type FinalizedDb = Pick<typeof prisma, "decisionOutcome">

const REVISABLE_REASONS = [UNOBSERVABLE_REASONS.CLOSE_DATE_MISSING, UNOBSERVABLE_REASONS.PAID_AT_MISSING, UNOBSERVABLE_REASONS.NO_SCHEDULE]

/** A returned debit order as its RETURNED_DEBIT_ORDER row would carry it. */
export interface ReturnedFact {
  ref: string
  installmentNo: number
  amountCents: number
  reasonCode: string | null
  resolvedAt: Date
}

export interface FinalizedCandidate {
  approvalId: string
  /** The returned debit orders the source holds for the loan. */
  returns: readonly ReturnedFact[]
  /** The loan row's last edit. */
  loanUpdatedAt: Date
}

const returnKey = (r: { ref: string; window: string; amountCents: number | null; reasonCode: string | null; at: Date | null }) =>
  [r.ref, r.window, r.amountCents, r.reasonCode, r.at?.getTime()].join("|")

/** The approvals, among the candidates (loans that have ended), whose rows need no new derivation. */
export async function finalizedApprovals(
  db: FinalizedDb,
  args: { tenantId: string; demoTenant: boolean; candidates: readonly FinalizedCandidate[] },
): Promise<Set<string>> {
  if (args.candidates.length === 0) return new Set()
  const where = {
    tenantId: args.tenantId, sourceSystem: "credaflow", decisionRecordId: { in: args.candidates.map((c) => c.approvalId) },
  }
  const [held, notFinal, returnRows] = await Promise.all([
    db.decisionOutcome.groupBy({ by: ["decisionRecordId", "outcomeKind"], where, _count: { _all: true }, _max: { computedAt: true } }),
    db.decisionOutcome.groupBy({
      by: ["decisionRecordId"],
      where: {
        ...where,
        OR: [
          { state: "PENDING" },
          { state: "UNOBSERVABLE", reasonCode: { in: REVISABLE_REASONS } },
          { definitionVersion: { not: OUTCOME_DEFINITION_VERSION } },
          { demoData: { not: args.demoTenant } },
        ],
      },
    }),
    db.decisionOutcome.findMany({
      where: { ...where, outcomeKind: "RETURNED_DEBIT_ORDER" },
      select: { decisionRecordId: true, window: true, sourceRef: true, amountCents: true, reasonCode: true, observedAt: true },
    }),
  ])
  const rows = new Map<string, number>()
  const computedAt = new Map<string, number>()
  for (const g of held) {
    rows.set(g.decisionRecordId, (rows.get(g.decisionRecordId) ?? 0) + g._count._all)
    computedAt.set(g.decisionRecordId, Math.max(computedAt.get(g.decisionRecordId) ?? 0, g._max.computedAt?.getTime() ?? 0))
  }
  const heldReturns = new Map<string, Set<string>>()
  for (const r of returnRows) {
    const set = heldReturns.get(r.decisionRecordId) ?? new Set<string>()
    heldReturns.set(r.decisionRecordId, set)
    set.add(returnKey({ ref: r.sourceRef, window: r.window, amountCents: r.amountCents, reasonCode: r.reasonCode, at: r.observedAt }))
  }
  const open = new Set(notFinal.map((g) => g.decisionRecordId))
  const sameReturns = (c: FinalizedCandidate) => {
    const held = heldReturns.get(c.approvalId) ?? new Set<string>()
    const source = new Set(c.returns.map((r) => returnKey({
      ref: r.ref, window: `INSTALMENT:${r.installmentNo}`, amountCents: r.amountCents, reasonCode: r.reasonCode, at: r.resolvedAt,
    })))
    return held.size === source.size && [...source].every((k) => held.has(k))
  }
  // The rows were last computed at their newest computedAt: a loan edited after that was not seen by it.
  return new Set(args.candidates
    .filter((c) => (rows.get(c.approvalId) ?? 0) > 0 && !open.has(c.approvalId) && sameReturns(c)
      && c.loanUpdatedAt.getTime() <= (computedAt.get(c.approvalId) ?? 0))
    .map((c) => c.approvalId))
}
