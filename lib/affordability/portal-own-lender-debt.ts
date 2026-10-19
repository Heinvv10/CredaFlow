import { InvalidAffordabilityDebtError, type AffordabilityDebtInput } from "@/lib/affordability/snapshot"
import { ownLenderArrears } from "@/lib/affordability/own-lender-debt"
import { loadOwnLenderDebts, ownAwareDebtTotal } from "@/lib/affordability/own-lender-debt-load"

type Db = Parameters<typeof loadOwnLenderDebts>[0]

const declaredTotal = (debts: readonly AffordabilityDebtInput[]) =>
  debts.reduce((sum, debt) => sum + Number(debt.monthlyInstalmentCents ?? debt.monthlyInstalment ?? 0), 0)

/**
 * The client's existing debt for the portal's qualify estimate: declared debts
 * plus their obligations to this lender (lib/affordability/own-lender-debt.ts),
 * as staff assess them, and the "in arrears with us" figure.
 *
 * An APPROVED, undisbursed application with no recorded instalment makes the
 * loader refuse (it cannot be counted). An estimate must still render, so that
 * one error falls back to the declared debt, logged; the application itself
 * stays refused wherever it is assessed. Any other error propagates.
 */
export async function portalExistingDebt(
  db: Db,
  tenantId: string,
  clientId: string,
  declared: readonly AffordabilityDebtInput[],
): Promise<{ existingDebt: number; ownLenderArrears: ReturnType<typeof ownLenderArrears> }> {
  try {
    const own = await loadOwnLenderDebts(db, tenantId, clientId)
    return { existingDebt: ownAwareDebtTotal(declared, own), ownLenderArrears: ownLenderArrears(own) }
  } catch (error) {
    if (!(error instanceof InvalidAffordabilityDebtError)) throw error
    console.warn(`[portal-qualify] own-lender debts not counted for client ${clientId}: ${error.message}`)
    return { existingDebt: declaredTotal(declared), ownLenderArrears: null }
  }
}
