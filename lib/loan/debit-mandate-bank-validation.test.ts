import { describe, expect, it } from "vitest"
import {
  debitMandateAccountNumberError,
  debitMandateBankNameError,
  debitMandateBranchCodeError,
} from "./debit-mandate-bank-validation"

describe("debit-mandate bank field validation", () => {
  it.each([
    "FNB (First National Bank)",
    "Bank Zero",
    "Sasfin Bank",
  ])("accepts an actual bank name: %s", (value) => {
    expect(debitMandateBankNameError(value)).toBeNull()
  })

  it.each([
    ["", "Enter the bank's actual name."],
    ["A", "Enter the bank's actual name."],
    ["Other", "Enter the bank's actual name."],
    ["Other Bank", "Enter the bank's actual name."],
    ["TODO", "Enter the bank's actual name."],
    ["A".repeat(81), "Enter the bank's actual name."],
  ])("rejects unresolved bank name %j", (value, expected) => {
    expect(debitMandateBankNameError(value)).toBe(expected)
  })

  it.each([
    "123456",
    "1234567890",
    "1234567890123456",
  ])("accepts a structurally valid account number: %s", (value) => {
    expect(debitMandateAccountNumberError(value)).toBeNull()
  })

  it.each([
    ["", "Enter a 6-16 digit account number."],
    ["12345", "Enter a 6-16 digit account number."],
    ["12345678901234567", "Enter a 6-16 digit account number."],
    ["12345A", "Enter a 6-16 digit account number."],
    ["0000000000", "Account number cannot be a repeated-digit placeholder."],
    ["111111", "Account number cannot be a repeated-digit placeholder."],
  ])("rejects account number %j", (value, expected) => {
    expect(debitMandateAccountNumberError(value)).toBe(expected)
  })

  it("accepts a structurally valid branch code", () => {
    expect(debitMandateBranchCodeError("250655")).toBeNull()
  })

  it.each([
    ["", "Enter a six-digit branch code."],
    ["25065", "Enter a six-digit branch code."],
    ["25065A", "Enter a six-digit branch code."],
    ["000000", "Branch code cannot be a repeated-digit placeholder."],
    ["111111", "Branch code cannot be a repeated-digit placeholder."],
  ])("rejects branch code %j", (value, expected) => {
    expect(debitMandateBranchCodeError(value)).toBe(expected)
  })
})
