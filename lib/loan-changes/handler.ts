import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import { applyLoanChange } from "./apply"
import { computeChange, involvedLoanIds } from "./compute"
import { parseLoanChangePayload } from "./payload"
import { LoanChangeRefused } from "./plan"
import { LOAN_CHANGE_KIND, type LoanChangePayload } from "./types"

/** Rewrites a refusal as the service's own, so the route answers with the reason. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof LoanChangeRefused) throw new InvalidPayloadError([error.message])
    throw error
  }
}

export const loanChangeHandler: ChangeHandler<LoanChangePayload> = {
  kind: LOAN_CHANGE_KIND,
  label: "Loan change",
  payloadVersion: 1,
  makePermission: "propose_loan_change",
  approvePermission: "approve_loan_change",
  parse: parseLoanChangePayload,
  async verify(tx: Tx, tenantId, payload) {
    await refusing(() => computeChange(tx, tenantId, payload, new Date()))
  },
  // A change is drafted against the loans' status and terms: another change, or a closure, in between makes it stale. A receipt
  // does not: the approval computes on the balance of that moment.
  async baseRef(tx: Tx, tenantId, payload) {
    const loans = await tx.loan.findMany({
      where: { tenantId, id: { in: involvedLoanIds(payload) } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, _count: { select: { terms: true } } },
    })
    return loans.map((loan) => `${loan.id}:${loan.status}:${loan._count.terms}`).join(",")
  },
  apply: (tx, ctx) => refusing(() => applyLoanChange(tx, ctx)),
}
