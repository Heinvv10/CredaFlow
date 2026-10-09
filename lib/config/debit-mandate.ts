export type DebitMandateCreditorBankDetails = {
  bankName: string
  accountNumber: string
  branchCode: string
}

export class DebitMandateConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DebitMandateConfigurationError"
  }
}

/**
 * The creditor collection account in this module is global deployment
 * configuration (env), not a tenant-owned field. Refuse
 * to render it for any request/document context outside the configured
 * tenant.
 */
export function assertDebitMandateCreditorTenant(
  tenantId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const configuredTenantId = env.DEBIT_MANDATE_CREDITOR_TENANT_ID?.trim()
  if (!configuredTenantId || !tenantId.trim() || tenantId !== configuredTenantId) {
    throw new DebitMandateConfigurationError(
      "Debit-mandate creditor identity is not configured for this tenant.",
    )
  }
}

/**
 * Debit-order collection details are independent from the customer's EFT
 * payment destination. Never guess them from STITCH_* or print placeholders
 * in an authority document.
 */
export function getDebitMandateCreditorBankDetails(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DebitMandateCreditorBankDetails {
  const bankName = env.DEBIT_MANDATE_CREDITOR_BANK_NAME?.trim()
  const accountNumber = env.DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER?.trim()
  const branchCode = env.DEBIT_MANDATE_CREDITOR_BRANCH_CODE?.trim()
  const placeholder = (value: string) =>
    /^(?:your[- _]|change(?:me)?$|replace(?:me)?$|example(?:[- _]|$)|todo$|n\/?a$|-+$)/i.test(value)
  const repeatedDigits = (value: string) => /^(\d)\1+$/.test(value)
  if (
    !bankName
    || bankName.length < 2
    || bankName.length > 80
    || placeholder(bankName)
    || !accountNumber
    || !/^\d{6,16}$/.test(accountNumber)
    || placeholder(accountNumber)
    || repeatedDigits(accountNumber)
    || !branchCode
    || !/^\d{6}$/.test(branchCode)
    || placeholder(branchCode)
    || repeatedDigits(branchCode)
  ) {
    throw new DebitMandateConfigurationError(
      "Debit-mandate creditor banking is not configured.",
    )
  }
  return { bankName, accountNumber, branchCode }
}
