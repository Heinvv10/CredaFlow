import { InvalidAffordabilityDebtError } from "@/lib/affordability/snapshot"
import { ownLenderArrears } from "@/lib/affordability/own-lender-debt"
import { loadOwnLenderDebts } from "@/lib/affordability/own-lender-debt-load"

type Db = Parameters<typeof loadOwnLenderDebts>[0]

/** Audit reason and portal error code for a refusal on own-lender arrears. */
export const OWN_LENDER_ARREARS_REASON = "own_lender_arrears" as const
export const OWN_LENDER_ARREARS_CODE = "OWN_LENDER_ARREARS"

/**
 * The client's arrears with this lender (any own loan with arrears > 0, the
 * definition the portal qualify page shows), or null when up to date.
 *
 * Applications a client makes for themselves (portal, website form) are
 * refused while this is non-null; staff applications only warn. The loader
 * refuses an approved, undisbursed application with no recorded instalment
 * (InvalidAffordabilityDebtError): arrears are then unknown, so null, and the
 * application is assessed (and refused if need be) where it is assessed.
 * Any other error propagates.
 */
export async function loadOwnLenderArrears(db: Db, tenantId: string, clientId: string) {
  try {
    return ownLenderArrears(await loadOwnLenderDebts(db, tenantId, clientId))
  } catch (error) {
    if (!(error instanceof InvalidAffordabilityDebtError)) throw error
    return null
  }
}
