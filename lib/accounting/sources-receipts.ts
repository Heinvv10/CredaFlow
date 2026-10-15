/**
 * Receipts as journal sources. A split over-payment (the refund-due half
 * carries `parentPaymentId`) is ONE source with its parent: re-stating how
 * much of the money was applied moves loan book to unallocated receipts and
 * never churns the bank.
 */
import type { AccountRole } from "./accounts"
import { addTo, before, type DesiredSource, type SourceLoan, type SourcePayment, type Vector } from "./source-types"
import { receivableOf } from "./sources-shared"

function receiptVector(loan: SourceLoan, p: SourcePayment, asOf: Date, writeOff: Date | null): Vector {
  const vector: Vector = {}
  const received = before(p.receivedAt, asOf)
  const reversed = p.reversed && before(p.reversedAt, asOf)
  // A status set by reconciliation after `asOf` was still UNAPPLIED at `asOf`.
  const status = p.allocationStatus !== "UNAPPLIED" && p.reconciledAt && !before(p.reconciledAt, asOf)
    ? "UNAPPLIED"
    : p.allocationStatus
  if (received && !reversed && status !== "REFUNDED") {
    const credit: AccountRole = status === "UNAPPLIED"
      ? "UNALLOCATED_RECEIPTS"
      : writeOff && writeOff.getTime() <= p.receivedAt.getTime() ? "BAD_DEBT_RECOVERY" : receivableOf(loan)
    // A recovery's proceeds came in as cash with the sale (RECOVERY_CLEARING already holds them), so the receipt only moves them.
    const debit: AccountRole = p.paymentMethod === "WAIVER" ? "WAIVER_EXPENSE" : p.recoveryProceeds ? "RECOVERY_CLEARING" : "BANK"
    addTo(vector, debit, p.amount)
    addTo(vector, credit, -p.amount)
  }
  return vector
}

function changeOf(loan: SourceLoan, members: SourcePayment[], asOf: Date): DesiredSource["change"] {
  const reversed = members.find((p) => p.reversed && before(p.reversedAt, asOf))
  if (reversed) return { type: "REVERSAL", date: reversed.reversedAt, description: `Receipt reversed on ${loan.reference}` }
  const refunded = members.find((p) => p.allocationStatus === "REFUNDED" && before(p.reconciledAt, asOf))
  if (refunded) return { type: "REFUND", date: refunded.reconciledAt, description: `Unallocated receipt refunded on ${loan.reference}` }
  const applied = members.find((p) => p.allocationStatus === "ALLOCATED" && before(p.reconciledAt, asOf))
  if (applied) return { type: "ALLOCATION", date: applied.reconciledAt, description: `Unallocated receipt applied to ${loan.reference}` }
  return { type: "ADJUSTMENT", date: null, description: `Receipt re-stated on ${loan.reference}` }
}

/** One source per receipt group (a payment and the halves split from it). */
export function receiptSources(loan: SourceLoan, asOf: Date, writeOff: Date | null): DesiredSource[] {
  const ids = new Set(loan.payments.map((p) => p.id))
  const groups = new Map<string, SourcePayment[]>()
  for (const p of loan.payments) {
    const root = p.parentPaymentId && ids.has(p.parentPaymentId) ? p.parentPaymentId : p.id
    groups.set(root, [...(groups.get(root) ?? []), p])
  }
  return [...groups.entries()].map(([rootId, members]) => {
    const root = members.find((p) => p.id === rootId) ?? members[0]
    const vector: Vector = {}
    for (const p of members) {
      for (const [role, cents] of Object.entries(receiptVector(loan, p, asOf, writeOff))) addTo(vector, role as AccountRole, cents ?? 0)
    }
    const waiver = root.paymentMethod === "WAIVER"
    return {
      baseKey: `payment:${rootId}`,
      loanId: loan.id,
      reference: loan.reference,
      vector,
      origin: waiver
        ? { type: "WAIVER", date: root.receivedAt, description: `Balance waived on ${loan.reference}` }
        : { type: "RECEIPT", date: root.receivedAt, description: `Receipt on ${loan.reference}` },
      change: changeOf(loan, members, asOf),
      // A split group re-stating its halves moves no cash: label that delta a reclass.
      reclass: members.length < 2 ? undefined : { type: "RECLASS", date: members.map((p) => p.reconciledAt).find((d) => d && before(d, asOf)) ?? null, description: `Over-payment on ${loan.reference} moved to unallocated receipts` },
    }
  })
}
