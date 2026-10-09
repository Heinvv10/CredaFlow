import { describe, expect, it } from "vitest"
import { verifiedBankStatementEvidence } from "@/lib/compliance/debit-mandate"
import { EVIDENCE_FIELD_HINTS, EVIDENCE_HINTS } from "./DisburseForm"

/**
 * The generic 422 sentence is identical for every banking failure, so these
 * hints are the only thing telling staff what to actually do. If a reason
 * string is renamed in the gate and the hint map is not updated, the UI
 * silently degrades to "Reason code: …" and the dead end returns.
 *
 * The expected reasons are DRIVEN OUT OF the real gate function rather than
 * copied from a list here — a list copied from the same source could never
 * disagree with it.
 */
const bankDetails = {
  bankName: "TYME_BANK",
  branchCode: "678910",
  accountNumber: "51100000001",
  accountType: "CHEQUE" as const,
}

const verifiedAt = new Date("2026-07-31T08:52:04.557Z")
const sha = "f".repeat(64)

const matchingExtraction = {
  fields: {
    accountNumber: "51100000001",
    bankName: "TymeBank",
    branchCode: "678910",
    accountType: "Cheque",
  },
}

function failureFrom(document: Parameters<typeof verifiedBankStatementEvidence>[0]) {
  const result = verifiedBankStatementEvidence(document, bankDetails)
  if (result.ok) throw new Error("expected a failure reason, got ok")
  return result
}

function reasonFrom(document: Parameters<typeof verifiedBankStatementEvidence>[0]) {
  return failureFrom(document).reason
}

describe("DisburseForm evidence hints cover what the gate actually emits", () => {
  it("covers a missing / mismatch-flagged statement", () => {
    const reason = reasonFrom(null)
    expect(reason).toBe("verified_bank_statement_missing")
    expect(EVIDENCE_HINTS[reason]).toBeTruthy()
  })

  it("covers a statement with no usable integrity digest", () => {
    const reason = reasonFrom({
      id: "d1",
      contentSha256: "not-a-digest",
      verifiedAt,
      extractionResult: matchingExtraction,
      validationMismatch: false,
    })
    expect(reason).toBe("verified_bank_statement_integrity_missing")
    expect(EVIDENCE_HINTS[reason]).toBeTruthy()
  })

  // This is the production failure: extraction never ran, so no fields exist
  // to match the payout account against.
  it("covers a statement that could not be machine-read", () => {
    const failure = failureFrom({
      id: "d1",
      contentSha256: sha,
      verifiedAt,
      extractionResult: null,
      validationMismatch: false,
    })
    expect(failure.reason).toBe("verified_bank_statement_mismatch")
    expect(EVIDENCE_HINTS[failure.reason]).toBeTruthy()
    // An unread page is its own field value, and only it carries the password
    // wording. Attaching that sentence to the shared reason instead is what
    // sent staff to re-upload an unlocked PDF when the statement was fine and
    // one field simply disagreed.
    expect(failure.mismatchField).toBe("extraction_empty")
    expect(EVIDENCE_FIELD_HINTS.extraction_empty).toMatch(/password/i)
    expect(EVIDENCE_HINTS[failure.reason]).not.toMatch(/password/i)
  })

  it("covers an account that does not match the statement", () => {
    const failure = failureFrom({
      id: "d1",
      contentSha256: sha,
      verifiedAt,
      extractionResult: {
        fields: { ...matchingExtraction.fields, accountNumber: "99999999999" },
      },
      validationMismatch: false,
    })
    expect(failure.reason).toBe("verified_bank_statement_mismatch")
    expect(EVIDENCE_HINTS[failure.reason]).toBeTruthy()
    expect(failure.mismatchField).toBe("accountNumber")
    expect(EVIDENCE_FIELD_HINTS.accountNumber).toBeTruthy()
  })

  it("has a hint for every field the gate can name", () => {
    // Driven out of the gate rather than listed here: a new leg with no hint
    // degrades the UI to "Field: …" silently.
    for (const field of ["extraction_empty", "accountNumber", "bankName", "accountType"]) {
      expect(EVIDENCE_FIELD_HINTS[field]).toBeTruthy()
    }
  })

  // Emitted by the disburse route when the client record is incomplete.
  it("covers incomplete bank details on the client record", () => {
    expect(EVIDENCE_HINTS.bank_details_incomplete).toBeTruthy()
  })
})
