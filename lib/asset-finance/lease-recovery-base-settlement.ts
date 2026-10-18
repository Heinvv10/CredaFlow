import type { Prisma } from "@prisma/client"
import { allocateReceipts, recomputeLoanBalances } from "@/lib/loan/balances"
import { loadChargesReplay, chargesOutstandingTotal } from "@/lib/loan/charges-replay"
import { currentSettlementAmount } from "@/lib/loan/settlement"
import type { SigningTx } from "./signing-prepare"

/** Recovery figures show new costs separately. Exclude this recovery's certified
 * cost events from the base settlement, and replay genuine receipts against that
 * baseline so neither costs nor fee allocations are counted twice.
 */
export async function leaseRecoveryBaseSettlement(tx: SigningTx, loan: Prisma.LoanGetPayload<{ include: { repaymentSchedule: true } }>, asOf: Date, recoveryId: string) {
  const ref = { tenantId: loan.tenantId, loanId: loan.id }
  const replay = await loadChargesReplay(tx, ref, asOf, { decidingStatus: true, excludeRecoveryCosts: recoveryId })
  let paid: number[]
  if (replay) {
    const paidById = new Map(replay.loan.repaymentSchedule.map((row, index) => [row.id, replay.result.scheduleRows[index].paid]))
    paid = loan.repaymentSchedule.map((row) => paidById.get(row.id) ?? 0)
  }
  else {
    const receipts = await tx.payment.findMany({ where: { tenantId: loan.tenantId, loanId: loan.id, reversed: false, allocationStatus: "ALLOCATED" }, select: { amount: true } })
    paid = allocateReceipts(loan.repaymentSchedule, receipts.reduce((sum, receipt) => sum + receipt.amount, 0))
  }
  const schedule = loan.repaymentSchedule.map((row, index) => ({ ...row, totalPaid: paid[index] }))
  const balances = recomputeLoanBalances(loan.principal, schedule, asOf)
  return currentSettlementAmount({ loan: { ...loan, ...balances, totalPaid: paid.reduce((sum, amount) => sum + amount, 0) }, schedule, asOf,
    chargesOutstanding: replay ? chargesOutstandingTotal(replay.result) : 0 })
}
