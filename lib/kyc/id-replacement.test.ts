import { describe, expect, it } from "vitest"
import { pendingIdReplacement, type IdReplacementCandidate } from "./id-replacement"

function copy(overrides: Partial<IdReplacementCandidate> & { id: string }): IdReplacementCandidate {
  return {
    docType: "ID_COPY",
    verified: false,
    createdAt: new Date("2026-07-20T08:00:00.000Z"),
    verificationRejectedById: null,
    ...overrides,
  }
}

const olderVerified = copy({ id: "id-a", verified: true })
const newerUnverified = copy({
  id: "id-b",
  createdAt: new Date("2026-07-21T08:00:00.000Z"),
})

describe("pendingIdReplacement", () => {
  it("returns the newer unreviewed copy while an older one is verified", () => {
    expect(pendingIdReplacement([olderVerified, newerUnverified])?.id).toBe("id-b")
    expect(pendingIdReplacement([newerUnverified, olderVerified])?.id).toBe("id-b")
  })

  it("is null when the newest copy is the verified one", () => {
    const olderUnverified = copy({ id: "id-old", createdAt: new Date("2026-07-19T08:00:00.000Z") })
    expect(pendingIdReplacement([olderUnverified, olderVerified])).toBeNull()
  })

  it("is null when the newer copy was refused by a named reviewer", () => {
    expect(pendingIdReplacement([
      olderVerified,
      { ...newerUnverified, verificationRejectedById: "officer-1" },
    ])).toBeNull()
  })

  it("treats a rejection timestamp alone as a refusal", () => {
    expect(pendingIdReplacement([
      olderVerified,
      { ...newerUnverified, verificationRejectedAt: new Date("2026-07-21T09:00:00.000Z") },
    ])).toBeNull()
  })

  it("looks past a refused newest copy to an unreviewed one before it", () => {
    const refusedNewest = copy({
      id: "id-c",
      createdAt: new Date("2026-07-22T08:00:00.000Z"),
      verificationRejectedById: "officer-1",
    })
    expect(pendingIdReplacement([olderVerified, newerUnverified, refusedNewest])?.id).toBe("id-b")
  })

  it("is null with no verified copy: that is a first review, not a replacement", () => {
    expect(pendingIdReplacement([newerUnverified])).toBeNull()
    expect(pendingIdReplacement([])).toBeNull()
  })

  it("ignores other document types", () => {
    expect(pendingIdReplacement([
      olderVerified,
      copy({ id: "poa", docType: "PROOF_OF_ADDRESS", createdAt: new Date("2026-07-22T08:00:00.000Z") }),
    ])).toBeNull()
  })

  it("breaks a createdAt tie on id, as every other ID-copy selection does", () => {
    const sameInstant = new Date("2026-07-21T08:00:00.000Z")
    const verifiedLow = copy({ id: "id-1", verified: true, createdAt: sameInstant })
    const unverifiedHigh = copy({ id: "id-2", createdAt: sameInstant })
    expect(pendingIdReplacement([verifiedLow, unverifiedHigh])?.id).toBe("id-2")
    const unverifiedLow = copy({ id: "id-0", createdAt: sameInstant })
    expect(pendingIdReplacement([verifiedLow, unverifiedLow])).toBeNull()
  })
})
