// Plain-language labels for the staff page. Dependency-free so the client
// component can import it.

export const HOLD_REASON_LABELS: Record<string, string> = {
  INVALID_SA_ID: "ID number is missing or fails the check digit",
  INVALID_SURNAME: "Surname is under two letters or has no vowel",
  MISSING_FORENAME: "No first name",
  INVALID_ACCOUNT_NUMBER: "Loan reference has a character the bureau does not accept, or is over 25 characters",
  ARREARS_WITHOUT_OVERDUE: "Months in arrears with nothing overdue",
  CLOSURE_WITH_BALANCE: "Closed, but a balance, overdue amount or instalment remains",
  ZERO_OPENING_BALANCE: "Opening balance is zero",
  BALANCE_WITHOUT_INSTALMENT: "A balance is owed but the instalment is zero",
  STATUS_WITHOUT_DATE: "Closed, written off or handed over with no date recorded",
  ADVERSE_WITHOUT_ARREARS: "Written off or handed over with nothing overdue",
  REGISTRATION_WITH_STATUS: "New account already carries a status",
  REGISTRATION_IN_CREDIT: "New account is in credit",
  REGISTRATION_WITH_LAST_PAYMENT: "New account already carries a last payment date",
  UNRENDERABLE: "A value is too large for its field in the bureau layout",
  DUPLICATE_ACCOUNT_NUMBER: "Another loan in the same file has the same account number",
  POST_PERIOD_ACTIVITY: "A payment, reversal, closure or write-off is dated after the period, so the month-end figure cannot be rebuilt",
  CHARGES_SWITCHED_AFTER_PERIOD: "Default charges were switched on or off after the period, so the month-end figure cannot be rebuilt",
  REOPENED_AFTER_CLOSURE: "Reopened after the bureau was told it closed. This needs a manual correction at the bureau",
  CANCELLED_AFTER_REGISTRATION: "Cancelled after it was registered at the bureau. This needs a manual correction at the bureau",
}

export const ADVERSE_LABELS: Record<string, string> = {
  W: "Written off",
  L: "Handed over to an attorney",
}

export const holdReasonLabel = (reason: string) => HOLD_REASON_LABELS[reason] ?? reason
