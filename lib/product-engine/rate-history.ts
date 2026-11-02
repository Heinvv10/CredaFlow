/**
 * A loan's rate by the day it took effect, read from LoanTerms, for what is charged on closed days: default interest must stay at the
 * rate of the day it accrued. ContractRate is the asset-finance contracts' table (guardContractRate refuses a LOAN contract, and holds
 * its rate to reference + margin with no floor), so a loan on the product engine has its history here.
 *
 * A row counts from the later of the reference's effective day and the day it was written: a repricing never reaches back over days
 * already charged, however late the value was approved. Null while the loan has one rate: nothing changes for it.
 */
export interface TermsRateRow {
  sequence: number
  interestRatePm: number
  referenceEffectiveDate: Date | null
  createdAt: Date
}

export function loanTermsRateHistory(terms: readonly TermsRateRow[] | undefined, startDate: Date): Array<{ effectiveDate: Date; annualRate: number }> | null {
  if (!terms || terms.length < 2) return null
  return [...terms].sort((a, b) => a.sequence - b.sequence).map((row, i) => {
    const from = row.referenceEffectiveDate && row.referenceEffectiveDate > row.createdAt ? row.referenceEffectiveDate : row.createdAt
    return { effectiveDate: i === 0 ? startDate : from, annualRate: row.interestRatePm * 12 }
  })
}
