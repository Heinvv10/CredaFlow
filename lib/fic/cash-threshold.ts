import type { PaymentMethod } from "@prisma/client"

/**
 * The cash threshold for FIC Act cash threshold reports (CTRs), in cents.
 *
 * VERIFY BEFORE A LENDER RELIES ON THIS. The value below is believed to be the
 * threshold in force since the 2022 amendments (R49,999.99) — LOW confidence:
 * it was not checked against the FIC's current notice, and neither was
 * whether the threshold is "at or above" or "above". The lender's compliance
 * officer must confirm both against the current FIC regulations and guidance
 * before go-live. This is the ONE place the figure lives; nothing else in the
 * codebase may state or assume it.
 *
 * Not modelled (not confirmed either): aggregation of smaller cash amounts
 * that together reach the threshold. Only single receipts are flagged.
 */
export const CASH_THRESHOLD_CENTS = 4_999_999

export type CashCandidateFacts = {
  paymentMethod: PaymentMethod
  amount: number
  reversed: boolean
}

/** A cash receipt the CTR register must show: CASH, not reversed, at or above the threshold. */
export function isReportableCash(p: CashCandidateFacts): boolean {
  return p.paymentMethod === "CASH" && !p.reversed && p.amount >= CASH_THRESHOLD_CENTS
}
