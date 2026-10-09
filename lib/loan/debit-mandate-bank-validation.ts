/**
 * One definition of "these banking details are real enough to debit".
 *
 * The staff mandate path and the customer portal both collect these fields.
 * When each owned its own copy of the rules they disagreed, so a value the
 * portal accepted could still fail mandate preparation later with a generic
 * error and no field to point at. These return the message to show, or null
 * when the value passes, so both callers reject the same inputs for the same
 * stated reason.
 */

function isRepeatedDigitPlaceholder(value: string): boolean {
  return /^(\d)\1+$/.test(value)
}

export function debitMandateBankNameError(value: string): string | null {
  const bankName = value.trim()
  if (
    bankName.length < 2
    || bankName.length > 80
    || /^(?:your[- _]|change(?:me)?$|replace(?:me)?$|example(?:[- _]|$)|todo$|n\/?a$|other(?: bank)?$|-+$)/i.test(bankName)
  ) {
    return "Enter the bank's actual name."
  }
  return null
}

export function debitMandateAccountNumberError(value: string): string | null {
  if (!/^\d{6,16}$/.test(value)) {
    return "Enter a 6-16 digit account number."
  }
  if (isRepeatedDigitPlaceholder(value)) {
    return "Account number cannot be a repeated-digit placeholder."
  }
  return null
}

export function debitMandateBranchCodeError(value: string): string | null {
  if (!/^\d{6}$/.test(value)) {
    return "Enter a six-digit branch code."
  }
  if (isRepeatedDigitPlaceholder(value)) {
    return "Branch code cannot be a repeated-digit placeholder."
  }
  return null
}
