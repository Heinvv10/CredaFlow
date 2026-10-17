import { pasqEvidenceIsIntact, type PasqBillingScheduleItem } from "@/lib/compliance/pasq"
import type { Prisma } from "@prisma/client"

interface BaselineRow {
  id: string
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue: number
  totalDue: number
  assetFinanceOpeningBalanceCents: number | null
}
export interface AssetRateRepriceBaseline {
  version: "asset-rate-reprice-v1"
  originalEvidenceSha256: string
  contractRateId: string
  annualRate: string
  effectiveDate: string
  totalInterestCents: number
  totalRepayableCents: number
  recurringPaymentCents: number
  rows: Array<PasqBillingScheduleItem & { id: string }>
}

/** A revised contractual baseline, leaving the signed PASQ untouched. The
 * database authenticates it against the immutable rate and original evidence,
 * then applies the existing normal/settlement/reversal guards to that baseline.
 */
export function assetRateRepriceBaseline(input: {
  original: Prisma.JsonValue | null
  contractRateId: string
  annualRate: string
  effectiveDate: string
  recurringPaymentCents: number
  rows: BaselineRow[]
}): AssetRateRepriceBaseline | null {
  if (!pasqEvidenceIsIntact(input.original)) return null
  const original = input.original
  return {
    version: "asset-rate-reprice-v1", originalEvidenceSha256: input.original.evidenceSha256,
    contractRateId: input.contractRateId, annualRate: input.annualRate, effectiveDate: input.effectiveDate,
    totalInterestCents: input.rows.reduce((sum, row) => sum + row.interestDue, 0),
    totalRepayableCents: input.rows.reduce((sum, row) => sum + row.totalDue, 0),
    recurringPaymentCents: input.recurringPaymentCents,
    rows: input.rows.map((row, index) => ({
      ...original.billing.schedule[index], id: row.id, installmentNo: row.installmentNo,
      dueDate: row.dueDate.toISOString(), principalDueCents: row.principalDue, interestDueCents: row.interestDue,
      feesDueCents: row.feesDue, baseFeesDueCents: row.feesDue - row.creditLifePremiumDue,
      creditLifePremiumDueCents: row.creditLifePremiumDue, totalDueCents: row.totalDue,
      openingBalanceCents: row.assetFinanceOpeningBalanceCents ?? 0,
      closingBalanceCents: input.rows[index + 1]?.assetFinanceOpeningBalanceCents ?? 0,
    })),
  }
}
