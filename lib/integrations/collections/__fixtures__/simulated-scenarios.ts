/**
 * The simulated collection rail's fixtures. Outcomes are a pure function of
 * the request, so a demo or a test gets the same answer every time and the
 * simulator keeps no state between calls.
 *
 * - Mandate authorisation: the last four digits of the debtor's account number.
 * - Collection outcome: the cents part of the instruction amount.
 *
 * All values are synthetic. Nothing here is a real account.
 */
import type { MandateStatusValue, NormalizedReason } from "../types"

/** Account-number suffix → how the "debtor" answers the authorisation request. Any other suffix authorises. */
export const MANDATE_AUTH_BY_ACCOUNT_SUFFIX: Readonly<Record<string, MandateStatusValue>> = Object.freeze({
  "0009": "REJECTED",
  "0008": "EXPIRED",
})

export type SimulatedCollectionOutcome =
  | { status: "PAID" }
  | { status: "UNPAID"; reason: NormalizedReason; rawCode: string }
  | { status: "DISPUTED"; reason: NormalizedReason; rawCode: string }
  | { status: "PENDING" }

/** Amount cents (amount % 100) → outcome. Any other cents value is PAID in full. */
export const COLLECTION_OUTCOME_BY_CENTS: Readonly<Record<number, SimulatedCollectionOutcome>> = Object.freeze({
  1: { status: "UNPAID", reason: "INSUFFICIENT_FUNDS", rawCode: "SIM-NPF" },
  2: { status: "UNPAID", reason: "ACCOUNT_CLOSED", rawCode: "SIM-ACCOUNT-CLOSED" },
  3: { status: "DISPUTED", reason: "PAYMENT_STOPPED", rawCode: "SIM-DISPUTE" },
  4: { status: "UNPAID", reason: "PAYMENT_STOPPED", rawCode: "SIM-STOPPED" },
  5: { status: "PENDING" },
})

/** Account numbers ending in "0009" fail AVS; every other account passes. */
export const AVS_FAIL_ACCOUNT_SUFFIX = "0009"
