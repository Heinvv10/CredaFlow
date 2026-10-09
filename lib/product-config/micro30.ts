export const MICRO30_CODE = "MICRO30"
export const MICRO30_PROTECTED_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
] as const

export const MICRO30_APPROVED_CONTRACT = {
  productType: "MICRO",
  minTermDays: 30,
  maxTermDays: 30,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL",
  monthlyServiceFee: 6_900,
} as const

export interface Micro30ContractCandidate {
  code: unknown
  productType: unknown
  minAmount?: unknown
  maxAmount?: unknown
  minTermDays: unknown
  maxTermDays: unknown
  interestRatePm: unknown
  interestModel: unknown
  monthlyServiceFee: unknown
  initiationFeeModel?: unknown
  initiationFeePct?: unknown
  initiationFeeMax?: unknown
  active?: unknown
}

export function micro30ContractIssues(
  candidate: Micro30ContractCandidate,
): string[] {
  if (
    typeof candidate.code !== "string"
    || candidate.code.trim().toUpperCase() !== MICRO30_CODE
  ) {
    return []
  }
  const issues: string[] = []
  for (const key of [
    "productType",
    "minTermDays",
    "maxTermDays",
    "interestRatePm",
    "interestModel",
    "monthlyServiceFee",
  ] as const) {
    if (candidate[key] !== MICRO30_APPROVED_CONTRACT[key]) issues.push(key)
  }
  return issues
}

export function micro30DecisionTermsChanged(
  before: Micro30ContractCandidate,
  after: Micro30ContractCandidate,
): boolean {
  return ([
    "code",
    "productType",
    "minAmount",
    "maxAmount",
    "minTermDays",
    "maxTermDays",
    "interestRatePm",
    "interestModel",
    "monthlyServiceFee",
    "initiationFeeModel",
    "initiationFeePct",
    "initiationFeeMax",
    "active",
  ] as const).some((key) => before[key] !== after[key])
}
