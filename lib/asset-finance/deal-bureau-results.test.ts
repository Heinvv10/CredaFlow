import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { bureauResultOutcome } from "./deal-bureau-results"

const client = {
  id: "client-1",
  idNumber: "9001015009087",
  firstName: "Test",
  lastName: "Person",
  gender: "MALE" as const,
  dateOfBirth: new Date("1990-01-01"),
}

describe("bureauResultOutcome", () => {
  it("marks a result stale when the current enquiry identity no longer matches", () => {
    const check = { clientId: client.id, subjectFingerprint: bureauSubjectFingerprint(client) }
    expect(bureauResultOutcome(check, client)).toBe("stored")
    expect(bureauResultOutcome(check, { ...client, firstName: "Corrected" })).toBe("stale")
  })
})
