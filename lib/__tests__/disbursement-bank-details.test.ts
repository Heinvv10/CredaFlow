import { describe, expect, it } from "vitest"
import { resolveDisbursementBankDetails } from "../disbursement-bank-details"

const clientBank = {
  bankName: "FNB (First National Bank)",
  bankAccountNumber: "5551234077",
  bankBranchCode: "250655",
  accountType: "CHEQUE" as const,
}

describe("resolveDisbursementBankDetails", () => {
  it("uses the client bank details when no override is requested", () => {
    expect(
      resolveDisbursementBankDetails({
        client: clientBank,
        request: { bankRef: "DISB-07" },
        hasVerifiedBankStatement: true,
      })
    ).toEqual({
      bank: "FNB (First National Bank)",
      accountNo: "5551234077",
      branchCode: "250655",
      accountType: "CHEQUE",
      bankRef: "DISB-07",
      overrideUsed: false,
      overrideProof: null,
    })
  })

  it("rejects normal on-file payout details without a verified bank statement", () => {
    expect(() =>
      resolveDisbursementBankDetails({
        client: clientBank,
        request: {},
        hasVerifiedBankStatement: false,
      })
    ).toThrow("A current verified bank statement is required")
  })

  it("rejects edited bank details without proof", () => {
    expect(() =>
      resolveDisbursementBankDetails({
        client: clientBank,
        request: { bank: "Capitec Bank", accountNo: "1234567890" },
        hasVerifiedBankStatement: true,
      })
    ).toThrow("Bank detail changes require proof of new bank details")
  })

  it("rejects edited bank details when proof is too short", () => {
    expect(() =>
      resolveDisbursementBankDetails({
        client: clientBank,
        request: { bank: "Capitec Bank", accountNo: "1234567890", overrideProof: "short" },
        hasVerifiedBankStatement: true,
      })
    ).toThrow("Bank detail changes require proof of new bank details")
  })

  it("allows edited bank details when proof is supplied and verified", () => {
    expect(
      resolveDisbursementBankDetails({
        client: clientBank,
        request: {
          bank: "Capitec Bank",
          accountNo: "1234567890",
          branchCode: "470010",
          accountType: "SAVINGS",
          overrideProof: "Verified new bank statement uploaded by admin",
        },
        hasVerifiedBankStatement: true,
      })
    ).toMatchObject({
      bank: "Capitec Bank",
      accountNo: "1234567890",
      branchCode: "470010",
      accountType: "SAVINGS",
      overrideUsed: true,
      overrideProof: "Verified new bank statement uploaded by admin",
    })
  })
})
