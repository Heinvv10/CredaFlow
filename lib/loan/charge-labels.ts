import type { ChargeType } from "@/lib/loan/default-charges"

/**
 * Consumer-facing names of the default charges.
 * A leaf module so the PDF documents and client components can use them.
 * Customer copy: changes need the lender's approval.
 */
export const CHARGE_TYPE_LABELS: Record<ChargeType, string> = {
  DEFAULT_INTEREST: "Default interest",
  SERVICE_FEE: "Service fee after due date",
  DEFAULT_ADMIN: "Collection letter fee",
}

/**
 * Arrears as shown to people: schedule arrears plus default charges owed, the
 * same figure the Section 129 notice states. Loan.arrearsAmount itself stays
 * schedule-only because DPD, escalation and Section 129 eligibility read it;
 * chargesOutstanding is the synced summary column (current to the last sync)
 * and counts only while charges are live for the tenant, so switching them off
 * takes them off every screen at once.
 */
export function arrearsWithCharges(
  loan: { arrearsAmount: number; chargesOutstanding: number },
  chargesLive: boolean,
): number {
  return loan.arrearsAmount + (chargesLive ? loan.chargesOutstanding : 0)
}
