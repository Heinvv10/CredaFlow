import { describe, expect, it } from "vitest"
import {
  bureauCheckMatchesSubject,
  bureauSubjectFingerprint,
} from "./bureau-subject"

const client = {
  id: "client-1",
  idNumber: "900101-5800-086",
  firstName: "Jane",
  lastName: "Doe",
  gender: "FEMALE" as const,
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

describe("bureau subject binding", () => {
  it("normalizes cosmetic identity formatting", () => {
    expect(bureauSubjectFingerprint(client)).toBe(bureauSubjectFingerprint({
      ...client,
      idNumber: "9001015800086",
      firstName: "  jane  ",
      lastName: "DOE",
    }))
  })

  it("rejects evidence for another client record or changed identity", () => {
    const subjectFingerprint = bureauSubjectFingerprint(client)

    expect(bureauCheckMatchesSubject({ clientId: client.id, subjectFingerprint }, client)).toBe(true)
    expect(bureauCheckMatchesSubject({ clientId: "client-2", subjectFingerprint }, client)).toBe(false)
    expect(bureauCheckMatchesSubject(
      { clientId: client.id, subjectFingerprint },
      { ...client, lastName: "Changed" },
    )).toBe(false)
    expect(bureauCheckMatchesSubject({ clientId: client.id, subjectFingerprint: null }, client)).toBe(false)
  })
})
