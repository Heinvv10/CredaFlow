/**
 * Validation of a credit-memo body (PUT /api/asset-finance/deals/[id]/
 * financials, goal decision 2a.3): AFS figures and a bank-statement summary.
 * Every money field is whole cents within ±9e15 (BIGINT columns,
 * ./big-cents.ts); only EBITDA may be negative (a loss year). The period end
 * is the AFS or management-accounts date and cannot be in the future.
 */
import { isFigureCents } from "./big-cents"
import { toDayNumber } from "./dates"
import { asRecord, readInt, readText, type Errors, type Fields } from "./input-fields"

export const CREDIT_MEMO_MONEY_FIELDS = [
  "turnoverCents",
  "ebitdaCents",
  "totalAssetsCents",
  "totalLiabilitiesCents",
  "existingDebtServiceCents",
  "avgMonthlyCreditsCents",
] as const

export type CreditMemoMoneyField = (typeof CREDIT_MEMO_MONEY_FIELDS)[number]

export type CreditMemoInput = Record<CreditMemoMoneyField, number> & {
  periodEnd: string
  returnedDebitsCount: number
  notes: string | null
}

export function parseCreditMemoInput(body: unknown, today: string): { data: CreditMemoInput } | { errors: Errors } {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const errors: Errors = {}
  const out: Fields = {}

  for (const key of CREDIT_MEMO_MONEY_FIELDS) {
    const allowNegative = key === "ebitdaCents"
    if (!isFigureCents(record[key], allowNegative)) {
      errors[key] = allowNegative
        ? "must be whole cents from -9e15 to 9e15"
        : "must be whole, non-negative cents up to 9e15"
    } else {
      out[key] = record[key]
    }
  }
  readInt(record, "returnedDebitsCount", out, errors, { required: true, nullable: false, min: 0, max: 100_000 })
  readText(record, "notes", out, errors, { required: false, nullable: true, max: 4000 })

  const periodEnd = record.periodEnd
  try {
    if (typeof periodEnd !== "string") throw new RangeError("missing")
    toDayNumber(periodEnd, "periodEnd")
    if (periodEnd > today) errors.periodEnd = "cannot be in the future"
  } catch {
    errors.periodEnd = "must be a calendar date YYYY-MM-DD"
  }

  if (Object.keys(errors).length > 0) return { errors }
  return {
    data: {
      periodEnd: periodEnd as string,
      turnoverCents: out.turnoverCents as number,
      ebitdaCents: out.ebitdaCents as number,
      totalAssetsCents: out.totalAssetsCents as number,
      totalLiabilitiesCents: out.totalLiabilitiesCents as number,
      existingDebtServiceCents: out.existingDebtServiceCents as number,
      avgMonthlyCreditsCents: out.avgMonthlyCreditsCents as number,
      returnedDebitsCount: out.returnedDebitsCount as number,
      notes: (out.notes as string | null | undefined) ?? null,
    },
  }
}
