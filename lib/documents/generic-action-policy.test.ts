import { describe, expect, it } from "vitest"
import {
  genericDocumentActionPolicy,
  isLockedStatutoryEvidence,
} from "./generic-action-policy"

describe("generic document action policy", () => {
  it.each([
    "CREDIT_AGREEMENT",
    "FORM_20_PRE_AGREEMENT",
    "DEBIT_MANDATE",
  ])("locks %s out of the generic workflow", (docType) => {
    expect(isLockedStatutoryEvidence(docType)).toBe(true)
    expect(genericDocumentActionPolicy(docType)).toEqual({
      lockedStatutoryEvidence: true,
      badgeLabel: "Locked statutory evidence",
      showGenericValidation: false,
      showGenericExtraction: false,
      canVerify: false,
      canExtract: false,
      canDelete: false,
    })
  })

  it.each([
    "ID_COPY",
    "PROOF_OF_ADDRESS",
    "PAYSLIP",
    "BANK_STATEMENT",
    "SELFIE",
    "OTHER",
  ])("keeps %s in the generic workflow", (docType) => {
    expect(isLockedStatutoryEvidence(docType)).toBe(false)
    expect(genericDocumentActionPolicy(docType)).toEqual({
      lockedStatutoryEvidence: false,
      badgeLabel: null,
      showGenericValidation: true,
      showGenericExtraction: true,
      canVerify: true,
      canExtract: true,
      canDelete: true,
    })
  })
})
