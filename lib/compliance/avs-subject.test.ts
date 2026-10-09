import { describe, expect, it } from "vitest"
import { avsCheckMatchesSubject, avsSubjectFingerprint } from "./avs-subject"

const client = {
  id: "client-1",
  idNumber: "900101-5800-086",
  firstName: "Jane",
  lastName: "Doe",
  bankName: "First National Bank",
  bankBranchCode: "250655",
  bankAccountNumber: "6200 0000 000",
  accountType: "CHEQUE",
}

describe("AVS subject binding", () => {
  it("normalizes cosmetic identity and account formatting", () => {
    expect(avsSubjectFingerprint(client)).toBe(avsSubjectFingerprint({
      ...client,
      idNumber: "9001015800086",
      firstName: "  jane ",
      lastName: "DOE",
      bankName: "first   national bank",
      bankAccountNumber: "62000000000",
    }))
  })

  it.each([
    { field: "idNumber", value: "8001015009087" },
    { field: "firstName", value: "Janet" },
    { field: "lastName", value: "Other" },
    { field: "bankName", value: "Other Bank" },
    { field: "bankBranchCode", value: "000000" },
    { field: "bankAccountNumber", value: "62000000001" },
    { field: "accountType", value: "SAVINGS" },
  ] as const)("invalidates evidence when $field changes", ({ field, value }) => {
    const subjectFingerprint = avsSubjectFingerprint(client)
    expect(avsCheckMatchesSubject(
      { clientId: client.id, subjectFingerprint },
      { ...client, [field]: value },
    )).toBe(false)
  })

  it("rejects evidence for another client and legacy evidence without a fingerprint", () => {
    const subjectFingerprint = avsSubjectFingerprint(client)
    expect(avsCheckMatchesSubject({ clientId: client.id, subjectFingerprint }, client)).toBe(true)
    expect(avsCheckMatchesSubject({ clientId: "client-2", subjectFingerprint }, client)).toBe(false)
    expect(avsCheckMatchesSubject({ clientId: client.id, subjectFingerprint: null }, client)).toBe(false)
  })
})
