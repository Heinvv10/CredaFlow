import { describe, expect, it } from "vitest"
import {
  assertDebitMandateCreditorTenant,
  DebitMandateConfigurationError,
  getDebitMandateCreditorBankDetails,
} from "./debit-mandate"

describe("getDebitMandateCreditorBankDetails", () => {
  it("loads dedicated debit-order creditor banking without borrowing payment config", () => {
    expect(getDebitMandateCreditorBankDetails({
      DEBIT_MANDATE_CREDITOR_BANK_NAME: " Provider Bank ",
      DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER: " 9876543210 ",
      DEBIT_MANDATE_CREDITOR_BRANCH_CODE: " 250655 ",
      STITCH_ACCOUNT_NUMBER: "must-not-be-used",
    })).toEqual({
      bankName: "Provider Bank",
      accountNumber: "9876543210",
      branchCode: "250655",
    })
  })

  it("fails closed rather than printing a placeholder creditor account", () => {
    expect(() => getDebitMandateCreditorBankDetails({
      STITCH_ACCOUNT_NUMBER: "unrelated-payment-account",
    })).toThrow(DebitMandateConfigurationError)
  })

  it("rejects the literal example placeholders and malformed bank identifiers", () => {
    expect(() => getDebitMandateCreditorBankDetails({
      DEBIT_MANDATE_CREDITOR_BANK_NAME: "your-debit-order-collection-bank",
      DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER: "your-debit-order-collection-account-number",
      DEBIT_MANDATE_CREDITOR_BRANCH_CODE: "your-debit-order-collection-branch-code",
    })).toThrow(DebitMandateConfigurationError)

    expect(() => getDebitMandateCreditorBankDetails({
      DEBIT_MANDATE_CREDITOR_BANK_NAME: "Provider Bank",
      DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER: "ABC123",
      DEBIT_MANDATE_CREDITOR_BRANCH_CODE: "12345",
    })).toThrow(DebitMandateConfigurationError)

    expect(() => getDebitMandateCreditorBankDetails({
      DEBIT_MANDATE_CREDITOR_BANK_NAME: "TODO",
      DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER: "0000000000",
      DEBIT_MANDATE_CREDITOR_BRANCH_CODE: "000000",
    })).toThrow(DebitMandateConfigurationError)
  })
})

describe("assertDebitMandateCreditorTenant", () => {
  it("allows only the tenant configured for the global creditor identity", () => {
    expect(() => assertDebitMandateCreditorTenant("tenant-a-id", {
      DEBIT_MANDATE_CREDITOR_TENANT_ID: "tenant-a-id",
    })).not.toThrow()
  })

  it("fails closed when the dedicated binding is absent or for another tenant", () => {
    expect(() => assertDebitMandateCreditorTenant("tenant-a-id", {}))
      .toThrow(DebitMandateConfigurationError)
    expect(() => assertDebitMandateCreditorTenant("tenant-b-id", {
      DEBIT_MANDATE_CREDITOR_TENANT_ID: "tenant-a-id",
    })).toThrow(DebitMandateConfigurationError)
  })
})
