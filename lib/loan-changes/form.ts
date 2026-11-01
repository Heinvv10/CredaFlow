/** What the proposal form holds, as typed, and the payload it files. Pure and client-safe. */
import { LOAN_CHANGE_LABELS, type LoanChangeType } from "./types"

export interface ChangeFormValues {
  type: LoanChangeType
  /** Percent a month, as typed. */
  ratePercent: string
  instalments: string
  holidayInstalments: string
  firstDueDate: string
  /** Major currency units, as typed. */
  newMoney: string
  payoutReference: string
  otherLoanIds: string[]
  signedDocumentId: string
  reason: string
}

export const FIELDS_OF: Record<LoanChangeType, ReadonlyArray<"rate" | "instalments" | "holiday" | "firstDue" | "newMoney" | "otherLoans">> = {
  RESCHEDULE: ["firstDue"], RESTRUCTURE: ["rate", "instalments"], PAYMENT_HOLIDAY: ["holiday"], RATE_CHANGE: ["rate"], TERM_CHANGE: ["instalments"],
  TOP_UP: ["newMoney", "instalments", "rate"], REFINANCE: ["instalments", "rate"], CONSOLIDATION: ["otherLoans", "instalments", "rate"],
}

export const emptyForm = (type: LoanChangeType): ChangeFormValues => ({
  type, ratePercent: "", instalments: "", holidayInstalments: "", firstDueDate: "", newMoney: "", payoutReference: "", otherLoanIds: [], signedDocumentId: "", reason: "",
})

const whole = (text: string) => Number(text)
const rate = (text: string) => Math.round(Number(text) * 10_000) / 1_000_000

/** Blank optional fields are left out; the server's parser says what is wrong with the rest. */
export function formPayload(loanId: string, form: ChangeFormValues): Record<string, unknown> {
  const fields = FIELDS_OF[form.type]
  return {
    type: form.type, loanId, reason: form.reason, signedDocumentId: form.signedDocumentId,
    ...(fields.includes("rate") && form.ratePercent !== "" ? { interestRatePm: rate(form.ratePercent) } : {}),
    ...(fields.includes("instalments") && form.instalments !== "" ? { instalments: whole(form.instalments) } : {}),
    ...(fields.includes("holiday") ? { holidayInstalments: whole(form.holidayInstalments) } : {}),
    ...(fields.includes("firstDue") ? { firstDueDate: form.firstDueDate } : {}),
    ...(fields.includes("newMoney") ? { newMoneyCents: Math.round(Number(form.newMoney) * 100), payoutReference: form.payoutReference } : {}),
    ...(fields.includes("otherLoans") ? { otherLoanIds: form.otherLoanIds } : {}),
  }
}

export const changeTitle = (type: LoanChangeType, reference: string) => `${LOAN_CHANGE_LABELS[type]} of ${reference}`
