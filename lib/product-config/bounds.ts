// Structural sanity for a loan product's amount (cents) and term (days)
// bounds. Downstream code (CRM convert, portal apply) trusts these values.
// Deliberately no upper cap: that is a product decision, not a validity one.

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0

export function loanProductBoundsIssues(data: {
  minAmount: unknown
  maxAmount: unknown
  minTermDays: unknown
  maxTermDays: unknown
}): string[] {
  const issues: string[] = []
  const minAmountOk = isPositiveInt(data.minAmount)
  if (!minAmountOk) issues.push("minAmount")
  if (!isPositiveInt(data.maxAmount) || (minAmountOk && data.maxAmount < (data.minAmount as number))) {
    issues.push("maxAmount")
  }
  const minTermOk = isPositiveInt(data.minTermDays)
  if (!minTermOk) issues.push("minTermDays")
  if (!isPositiveInt(data.maxTermDays) || (minTermOk && data.maxTermDays < (data.minTermDays as number))) {
    issues.push("maxTermDays")
  }
  return issues
}
