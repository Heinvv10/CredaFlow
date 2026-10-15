/**
 * The maintenance fund of a full-maintenance lease (slice 3, C5). Pure.
 *
 * The balance is derived from the immutable movements, never stored:
 *   + CONTRIBUTION       each rental's maintenance ex VAT, written when the
 *                        rental's tax invoice is issued (./lease-invoices.ts)
 *   − CLAIM              a maintenance claim, written when it is PAID
 *   − SETTLEMENT_REFUND  a surplus refunded to the lessee at the end of term
 *   + SETTLEMENT_BILLED  a deficit invoiced to the lessee at the end of term
 * The fund may go negative (claims ahead of contributions).
 *
 * END OF TERM (the deal's maintenanceRiskModel):
 *   LENDER_RISK     the lessor keeps a surplus and bears a deficit: reported only;
 *   LESSEE_SETTLED  a surplus is refunded (a recorded refund: the money moves
 *                   outside CredaFlow, as payouts do), a deficit billed on the
 *                   end-of-term tax invoice.
 */
export type MovementKind = "CONTRIBUTION" | "CLAIM" | "SETTLEMENT_REFUND" | "SETTLEMENT_BILLED"
export type RiskModel = "LENDER_RISK" | "LESSEE_SETTLED"

const SIGN: Record<MovementKind, 1 | -1> = { CONTRIBUTION: 1, CLAIM: -1, SETTLEMENT_REFUND: -1, SETTLEMENT_BILLED: 1 }

export function fundBalance(movements: readonly { kind: MovementKind; amountCents: number }[]): number {
  return movements.reduce((sum, m) => sum + SIGN[m.kind] * m.amountCents, 0)
}

export type FundSettlement =
  | { kind: "REPORTED"; surplusCents: number }
  | { kind: "REFUND"; amountCents: number }
  | { kind: "BILL"; amountCents: number }
  | { kind: "NONE" }

export function fundSettlement(riskModel: RiskModel, balanceCents: number): FundSettlement {
  if (riskModel === "LENDER_RISK") return { kind: "REPORTED", surplusCents: balanceCents }
  if (balanceCents > 0) return { kind: "REFUND", amountCents: balanceCents }
  if (balanceCents < 0) return { kind: "BILL", amountCents: -balanceCents }
  return { kind: "NONE" }
}

/** A claim at or above the tenant threshold needs a second, different approver (DB: MaintenanceClaim_four_eyes). */
export function needsSecondApprover(amountCents: number, thresholdCents: number): boolean {
  return amountCents >= thresholdCents
}
