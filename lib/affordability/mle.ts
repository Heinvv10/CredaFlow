// 2015 NCA Regulations, Schedule to Regulation 23A — Minimum Expense Norms.
// Source: National Credit Regulations, 2015 (Government Notice R.202 in
// GG 38557, 13 March 2015). The bracket values below are load-bearing legal
// constants — edit only with legal sign-off.
//
// LEGAL_WORDING_BEGIN
//   Gross monthly income →  minimum essential expenses
//   R0          – R800           →  100% of gross
//   R800.01     – R6,250         →  R800   + 6.75% of (gross − R800)
//   R6,250.01   – R25,000        →  R1,167.88 + 9.00% of (gross − R6,250)
//   R25,000.01  – R50,000        →  R2,855.38 + 8.20% of (gross − R25,000)
//   R50,000.01  +                →  R4,905.38 + 6.75% of (gross − R50,000)
// LEGAL_WORDING_END

export const MLE_FORMULA_VERSION = "2015-NCA-Reg-23A"

export function minimumLivingExpense(grossIncomeCents: number): number {
  if (grossIncomeCents <= 800_00) return grossIncomeCents
  if (grossIncomeCents <= 6_250_00) {
    return 800_00 + Math.round((grossIncomeCents - 800_00) * 0.0675)
  }
  if (grossIncomeCents <= 25_000_00) {
    return 1_167_88 + Math.round((grossIncomeCents - 6_250_00) * 0.09)
  }
  if (grossIncomeCents <= 50_000_00) {
    return 2_855_38 + Math.round((grossIncomeCents - 25_000_00) * 0.082)
  }
  return 4_905_38 + Math.round((grossIncomeCents - 50_000_00) * 0.0675)
}
