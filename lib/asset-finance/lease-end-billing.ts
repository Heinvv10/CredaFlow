/**
 * What must hold before a lease's end of term is billed (slice 3, C7–C8),
 * checked before invoiceEndOfTerm (./lease-end-invoice.ts) writes anything:
 *   - a purchase is sale-invoiced only once the term has ended
 *     (./lease-term-end.ts), on a valuation still current;
 *   - every rental still to be paid has its tax invoice (the fund's last
 *     contributions are in before it is settled);
 *   - no maintenance claim is open (submitted or approved): it is paid or
 *     rejected first, so the fund is settled on its final balance;
 *   - damage assessed by one person is billed by another.
 * The database repeats the timing and the settled-fund rules
 * (guardLeaseEndOfTerm, guardMaintenanceFundMovement).
 */
import { isoOfDbDate } from "./dates"
import { checkPurchaseValuation, leaseTermEnd } from "./lease-term-end"
import type { EndResult } from "./lease-end-of-term"
import type { SigningTx } from "./signing-prepare"

type Refusal = Extract<EndResult, { kind: "refused" }>
const refused = (reason: string, error: string): Refusal => ({ kind: "refused", reason, error })

export async function billingRefusal(
  tx: SigningTx,
  input: {
    tenantId: string; loanId: string; today: string; actorUserId: string
    row: { outcome: string; assetId: string; purchaseValuationId: string | null; inspectedById: string | null; damageItems: readonly unknown[] }
  },
): Promise<Refusal | null> {
  const { tenantId, loanId, row } = input
  if (row.outcome === "PURCHASE") {
    const termEnd = await leaseTermEnd(tx, tenantId, loanId)
    if (termEnd !== null && input.today < termEnd) return refused("term_running", `The asset is sold when the term ends on ${termEnd}`)
    if (!row.purchaseValuationId) return refused("purchase_terms", "The purchase has no valuation")
    const valuation = await checkPurchaseValuation(tx, { tenantId, assetId: row.assetId, valuationId: row.purchaseValuationId, today: input.today, electorUserId: null })
    if (!valuation.ok) return refused(valuation.reason, `${valuation.error}: elect again on a current valuation`)
  }
  const pending = await tx.leaseRental.findFirst({ where: { tenantId, loanId, cancelledAt: null, taxInvoiceId: null }, orderBy: { periodNo: "asc" }, select: { dueDate: true } })
  if (pending) return refused("rentals_pending", `The rental due ${isoOfDbDate(pending.dueDate)} is not invoiced yet`)
  const openClaim = await tx.maintenanceClaim.findFirst({ where: { tenantId, fund: { loanId }, status: { in: ["SUBMITTED", "APPROVED"] } }, select: { id: true } })
  if (openClaim) return refused("open_claims", "A maintenance claim is still open: pay or reject it first")
  if (row.damageItems.length > 0 && row.inspectedById === input.actorUserId) {
    return refused("four_eyes", "Damage assessed at the inspection is billed by someone other than the inspector")
  }
  return null
}
