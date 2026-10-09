import type { AdminChargeEvent } from "@/lib/loan/default-charges"
import { ChargesError } from "@/lib/loan/charges-error"

// Inputs the charges replay reads from stored rows (lib/loan/charges-replay.ts).
// ALL money is CENTS.

export class UnfrozenLetterError extends ChargesError {
  constructor(readonly letterId: string) {
    super(
      `Section 129 notice ${letterId} has no frozen admin charge (data.adminChargeCents); `
      + "run the default-charges back-fill --apply, which stamps it",
    )
    this.name = "UnfrozenLetterError"
  }
}

/**
 * One admin charge per confirmed notice, at the amount frozen on it at
 * finalise (or stamped by --apply). A notice without one is refused, never
 * priced at today's tenant setting — except in the back-fill dry run, which
 * previews the amount --apply would stamp (`previewCents`).
 */
export function letterCharges(
  letters: Array<{ id: string; completedAt: Date | null; data: unknown }>,
  previewCents: number | null,
): AdminChargeEvent[] {
  return letters.map((letter) => {
    const data = letter.data as { adminChargeCents?: unknown; adminChargeAt?: unknown } | null
    const frozen = data?.adminChargeCents
    if (typeof frozen !== "number" && previewCents === null) throw new UnfrozenLetterError(letter.id)
    // Dated when it was recorded (finalise), never before the provider's issue.
    const date = typeof data?.adminChargeAt === "string" ? new Date(data.adminChargeAt) : letter.completedAt!
    return { id: letter.id, date, amount: typeof frozen === "number" ? frozen : previewCents! }
  })
}

/**
 * The fee for a loan booked without Loan.monthlyServiceFee (an older image,
 * during a migrate-first deploy): the approval snapshot's fee, else the
 * product's — the migration back-fill's rule. The sync writes it onto the loan
 * the first time, so it never drifts with the product afterwards.
 */
export function bookedServiceFee(loan: {
  application: { affordabilityResult: unknown } | null
  product: { monthlyServiceFee: number }
}): number {
  const snapshot = loan.application?.affordabilityResult as
    { approval?: { inputs?: { monthlyServiceFeeCents?: unknown } } } | null | undefined
  const fee = snapshot?.approval?.inputs?.monthlyServiceFeeCents
  return typeof fee === "number" ? fee : loan.product.monthlyServiceFee
}

/**
 * What the first --apply switches a tenant to (its live state when already
 * live): the go-live and the admin charge it stamps on unfrozen notices. The
 * dry run replays with exactly these (lib/loan/charges-switch.ts goLiveInputs).
 */
export interface GoLiveInputs {
  startedAt: Date
  letterCents: number
}
