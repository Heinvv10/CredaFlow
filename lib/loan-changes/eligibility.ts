/** Whether a loan can be changed at all, whatever the proposal. Pure; each reason is shown to staff as it stands. */

export const NCA_REFUSAL =
  "Not available on an NCA loan: a change needs an amended or new credit agreement, and no approved wording for one exists. The PASQ, the agreement and the debit order print this schedule. Use a payment arrangement, or a new application."

/** The loan's facts that decide it (lib/loan-changes/compute.ts reads them). */
export interface LoanChangeFacts {
  status: string
  productActive: boolean
  disclosureRegime: string
  contractType: string
  assetFinance: boolean
  hasClient: boolean
  deceased: boolean
  interestModel: string
  creditLifePremiums: number
  repaymentMethod: string | null
  debtReview: boolean
  collectionsStage: string
  arrangementActive: boolean
  paymentPlanActive: boolean
  mandates: number
  collectionInstructions: number
  chargesAccrued: number
  chargesOutstanding: number
  /** The rows' principal and paid amounts equal the loan's. */
  scheduleTies: boolean
}

export type ChangeScope = "IN_PLACE" | "NEW_LOAN"

export function changeRefusal(loan: LoanChangeFacts, scope: ChangeScope): string | null {
  if (loan.disclosureRegime !== "KEY_FACTS") return NCA_REFUSAL
  if (loan.contractType !== "LOAN" || loan.assetFinance) return "An asset-finance contract is changed through its own rate and early-settlement steps."
  if (!loan.hasClient) return "Only a loan to a person can be changed here."
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return "Only an active or defaulted loan can be changed."
  if (loan.deceased) return "This borrower is recorded as deceased: their estate is dealt with outside loan changes."
  if (loan.interestModel === "DAILY_ACCRUAL") return "A daily-accrual loan is a single payment: settle it instead."
  if (loan.creditLifePremiums > 0) return "This loan carries credit life, which is billed on the schedule the change would replace."
  if (loan.repaymentMethod !== "EFT" || loan.mandates > 0 || loan.collectionInstructions > 0) return "This loan is collected by debit order. Its mandate states the instalment and date a change would replace: cancel it first."
  if (loan.debtReview) return "This loan is under debt review: its repayments are set by that process."
  if (loan.collectionsStage === "ATTORNEY_REFERRED") return "This loan is with an attorney: recall it first."
  if (loan.arrangementActive || loan.paymentPlanActive) return "This loan has a live payment arrangement or plan: end it first."
  if (scope === "NEW_LOAN" && !loan.productActive) return "This loan's product is no longer offered: a new loan cannot be written on it."
  if (scope === "IN_PLACE") {
    if (loan.chargesAccrued > 0 || loan.chargesOutstanding > 0) return "This loan carries default charges, which are derived from its schedule: refinance it, which settles them, instead."
    if (!loan.scheduleTies) return "This loan's schedule does not add up to its principal and receipts. Have it checked before changing it."
  }
  return null
}
