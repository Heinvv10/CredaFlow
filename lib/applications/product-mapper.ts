import type { ApplicationProduct } from "@/components/applications/wizard/types"

// Shape of the Prisma `loanProduct` row, restricted to the columns both
// loaders select. Decimal columns arrive as Prisma's `Decimal`, which
// coerces to number via `Number()`. Kept as a structural type so callers
// don't need to import a runtime value.
export interface LoanProductRow {
  id: string
  name: string
  code: string
  minAmount: number | bigint | { toString(): string }
  maxAmount: number | bigint | { toString(): string }
  minTermDays: number
  maxTermDays: number
  interestRatePm: number | { toString(): string }
  interestModel: string
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number | { toString(): string }
  initiationFeeMax: number | bigint | { toString(): string }
  monthlyServiceFee: number | bigint | { toString(): string }
  /** Selects the NCA initiation-fee regime — see lib/loan/nca-fee-cap.ts. */
  productType: string | null
}

// Maps a stored loan product row to the wizard's ApplicationProduct contract.
// DB stores {min,max}Amount as cents; the wizard contract is rand. This is the
// only place that conversion happens — both SSR loaders go through here.
export function toApplicationProduct(row: LoanProductRow): ApplicationProduct {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    // Carried so the wizard's calculateLoan picks the right NCA fee regime.
    productType: row.productType,
    minAmount: Number(row.minAmount) / 100,
    maxAmount: Number(row.maxAmount) / 100,
    minTermDays: row.minTermDays,
    maxTermDays: row.maxTermDays,
    interestRate: Number(row.interestRatePm),
    interestRatePm: Number(row.interestRatePm),
    interestModel: row.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
    initiationFeeModel: row.initiationFeeModel,
    initiationFeePct: Number(row.initiationFeePct),
    initiationFeeMax: Number(row.initiationFeeMax),
    monthlyServiceFee: Number(row.monthlyServiceFee),
  }
}
