import type { ChargePause } from "@/lib/loan/charge-pauses"
import type { AdminChargeEvent } from "@/lib/loan/default-charges"

// A recovery's charge freeze as pauses for the charges replay
// (lib/loan/charges-replay.ts). Kept free of the database and of the audit
// writer so the replay can import it.
//
// The freeze starts on the day the sale proceeds are applied and ends on the
// deadline, both inclusive. An NCA recovery learns its deadline only when the
// final notice is issued (10 business days on, s127(8)), so between the
// proceeds and that notice the freeze is open-ended: nothing accrues until the
// lender issues the notice that fixes the end.
// UNTESTED: legal | the freeze start and the open-ended gap need the lender's legal sign-off.

export interface RecoveryFreezeRow {
  chargesFrozenFrom: Date | null
  chargesFrozenUntil: Date | null
  /** The recovery's APPROVED costs charged to the account (CHARGE_TO_ACCOUNT). */
  costs?: Array<{ id: string; grossCents: number }>
}

const OPEN_ENDED = new Date(Date.UTC(9999, 0, 1))

/** The pauses for every recovery of the loan that has started its freeze, or undefined when none has. */
export function recoveryChargePauses(rows: readonly RecoveryFreezeRow[] | undefined): ChargePause[] | undefined {
  const pauses = (rows ?? []).flatMap((row) => (row.chargesFrozenFrom ? [{ from: row.chargesFrozenFrom, until: row.chargesFrozenUntil ?? OPEN_ENDED }] : []))
  return pauses.length > 0 ? pauses : undefined
}

/**
 * The recovery's approved charged costs as charges on the loan, each dated the
 * day its proceeds were applied (the freeze's first day), or undefined when
 * there are none. The engines post them outside the freeze (a fixed cost, not
 * an accruing charge); the NCA engine keeps them inside the in duplum headroom.
 */
export function recoveryCostCharges(rows: readonly RecoveryFreezeRow[] | undefined): AdminChargeEvent[] | undefined {
  const charges = (rows ?? []).flatMap((row) => (row.chargesFrozenFrom ? (row.costs ?? []).map((cost) => ({ id: cost.id, date: row.chargesFrozenFrom as Date, amount: cost.grossCents })) : []))
  return charges.length > 0 ? charges : undefined
}
