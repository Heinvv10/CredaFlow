import { describe, expect, it } from "vitest"
import { bankEvidenceAuditValue, bankEvidenceFingerprint } from "./bank-evidence"

const tuple = {
  bankName: "First National Bank",
  bankAccountNumber: "6200 0000 000",
  bankBranchCode: "250655",
  accountType: "CHEQUE",
}

describe("bank evidence audit binding", () => {
  it("normalizes cosmetic formatting while binding the full payout tuple", () => {
    expect(bankEvidenceFingerprint(tuple)).toBe(bankEvidenceFingerprint({
      ...tuple,
      bankName: " first   national bank ",
      bankAccountNumber: "62000000000",
      bankBranchCode: "250-655",
      accountType: " cheque ",
    }))

    expect(bankEvidenceFingerprint({ ...tuple, bankBranchCode: "000000" }))
      .not.toBe(bankEvidenceFingerprint(tuple))
  })

  it("never exposes the full account number in the audit projection", () => {
    const audit = bankEvidenceAuditValue(tuple)

    expect(audit.accountNumberMasked).toBe("*******0000")
    expect(JSON.stringify(audit)).not.toContain("62000000000")
    expect(audit.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
})
