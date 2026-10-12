/**
 * Monthly payroll figures for a persona.
 *
 * PAYE follows the published SARS individual tables closely enough to look
 * right on a payslip; it is NOT a tax calculator and nothing in the app reads
 * it. What IS load-bearing is the identity gross − totalDeductions === net,
 * because applyPayslipPostProcessing (lib/vlm-extract.ts) distrusts any
 * extraction where it does not hold.
 */
import type { Payroll } from './types'

/** [annual threshold (rands), base tax (rands), marginal rate] */
const TAX_BRACKETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0.18],
  [237_100, 42_678, 0.26],
  [370_500, 77_362, 0.31],
  [512_800, 121_475, 0.36],
  [673_000, 179_147, 0.39],
  [857_900, 251_258, 0.41],
  [1_817_000, 644_489, 0.45],
]
const PRIMARY_REBATE_RANDS = 17_235
const UIF_CAP_CENTS = 177_12

function annualTaxRands(taxableAnnualRands: number): number {
  let tax = 0
  for (const [threshold, base, rate] of TAX_BRACKETS) {
    if (taxableAnnualRands > threshold) tax = base + (taxableAnnualRands - threshold) * rate
  }
  return Math.max(0, tax - PRIMARY_REBATE_RANDS)
}

export function buildPayroll(args: {
  basicCents: number
  allowanceCents: number
  hasPension: boolean
  medicalAidCents: number
  taxReference: string
}): Payroll {
  const grossCents = args.basicCents + args.allowanceCents
  const pensionCents = args.hasPension ? Math.round(args.basicCents * 0.075) : 0
  const taxableMonthlyCents = grossCents - pensionCents
  const payeCents = Math.round((annualTaxRands((taxableMonthlyCents / 100) * 12) * 100) / 12)
  const uifCents = Math.min(UIF_CAP_CENTS, Math.round(grossCents * 0.01))
  const totalDeductionsCents = payeCents + uifCents + pensionCents + args.medicalAidCents
  return {
    basicCents: args.basicCents,
    allowanceCents: args.allowanceCents,
    grossCents,
    payeCents,
    uifCents,
    pensionCents,
    medicalAidCents: args.medicalAidCents,
    totalDeductionsCents,
    netCents: grossCents - totalDeductionsCents,
    taxReference: args.taxReference,
  }
}
