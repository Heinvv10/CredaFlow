import type { ProductTypeName } from "@/lib/product-config/product-kind"

export interface ProductFactsInput {
  employerName: string | null
  payrollNumber: string | null
  businessName: string | null
  businessRegistrationNumber: string | null
  annualTurnoverCents: bigint | null
  borrowerGroupId: string | null
}

const empty: ProductFactsInput = { employerName: null, payrollNumber: null, businessName: null, businessRegistrationNumber: null, annualTurnoverCents: null, borrowerGroupId: null }

function text(raw: unknown, key: string, label: string, min: number, max: number, problems: string[]): string | null {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    problems.push(`${label}: ${min} to ${max} characters`)
    return null
  }
  return value.trim()
}

/** The facts this type carries, every other one null: a fact that does not belong to the type is not stored. A revolving product has none. */
export function parseProductFacts(type: ProductTypeName, raw: unknown): { facts: ProductFactsInput } | { problems: string[] } {
  const problems: string[] = []
  const facts = { ...empty }
  if (type === "SALARY_BACKED") {
    facts.employerName = text(raw, "employerName", "employerName", 2, 120, problems)
    facts.payrollNumber = text(raw, "payrollNumber", "payrollNumber", 1, 40, problems)
  } else if (type === "SME") {
    facts.businessName = text(raw, "businessName", "businessName", 2, 120, problems)
    facts.businessRegistrationNumber = text(raw, "businessRegistrationNumber", "businessRegistrationNumber", 1, 40, problems)
    const turnover = raw && typeof raw === "object" ? (raw as Record<string, unknown>).annualTurnoverCents : undefined
    if (turnover !== null && turnover !== undefined) {
      if (typeof turnover !== "number" || !Number.isSafeInteger(turnover) || turnover <= 0) problems.push("annualTurnoverCents: a positive whole number of cents")
      else facts.annualTurnoverCents = BigInt(turnover)
    }
  } else if (type === "GROUP") {
    facts.borrowerGroupId = text(raw, "borrowerGroupId", "borrowerGroupId", 1, 60, problems)
  } else {
    problems.push("a revolving product carries no application facts: its limit is the product's maximum amount")
  }
  return problems.length > 0 ? { problems } : { facts }
}
