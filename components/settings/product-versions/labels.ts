import { formatMoney } from "@/lib/jurisdiction/money"
import type { Currency } from "@/lib/jurisdiction/profiles"
import type { Frequency, GraceKind, RepaymentStructure } from "@/lib/product-engine/types"

export const FREQUENCY_LABEL: Record<Frequency, string> = { WEEKLY: "Weekly", FORTNIGHTLY: "Fortnightly", MONTHLY: "Monthly" }
export const STRUCTURE_LABEL: Record<RepaymentStructure, string> = { AMORTISING: "Equal instalments (amortising)", INTEREST_ONLY: "Interest only, principal at the end", BULLET: "Bullet: one payment at the end" }
export const GRACE_LABEL: Record<GraceKind, string> = { NONE: "No grace", PRINCIPAL_ONLY: "Principal-only grace (interest is paid)", FULL: "Full grace (nothing is paid)" }

export const money = (cents: number, currency: Currency) => formatMoney(cents, currency)
export const pct = (decimal: number) => `${Math.round(decimal * 10_000) / 100}%`

/** One line for a repayment structure, or what a product with none does. */
export function describeRepayment(r: { frequency: Frequency; structure: RepaymentStructure; graceKind: GraceKind; graceInstalments: number } | null, interestModel: string): string {
  if (!r) return interestModel === "DAILY_ACCRUAL" ? "Single payment (daily accrual)" : interestModel === "FLAT" ? "Single payment (flat)" : "Monthly instalments"
  const grace = r.graceKind === "NONE" ? "" : `, ${r.graceInstalments} ${r.graceKind === "FULL" ? "full-grace" : "principal-only"} period${r.graceInstalments === 1 ? "" : "s"}`
  return `${FREQUENCY_LABEL[r.frequency]} · ${STRUCTURE_LABEL[r.structure].split(" (")[0]!.split(":")[0]!.toLowerCase()}${grace}`
}
