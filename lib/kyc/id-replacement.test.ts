import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  outstandingCoreDocuments,
  pendingIdReplacement,
  type IdReplacementCandidate,
} from "./id-replacement"

/** Distinct, well-formed bytes per copy unless a case says otherwise. */
const digestOf = (seed: string) => createHash("sha256").update(seed).digest("hex")

function copy(overrides: Partial<IdReplacementCandidate> & { id: string }): IdReplacementCandidate {
  return {
    docType: "ID_COPY",
    verified: false,
    createdAt: new Date("2026-07-20T08:00:00.000Z"),
    contentSha256: digestOf(overrides.id),
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

describe("pendingIdReplacement: a byte-identical re-upload", () => {
  const sameBytes = { ...newerUnverified, contentSha256: olderVerified.contentSha256 }

  it("is not a replacement when the newer copy has the verified copy's digest", () => {
    expect(pendingIdReplacement([olderVerified, sameBytes])).toBeNull()
    expect(outstandingCoreDocuments(["ID_COPY"], [olderVerified, sameBytes])).toEqual([])
  })

  it("never matches on a missing digest, even when both are missing", () => {
    expect(pendingIdReplacement([olderVerified, { ...newerUnverified, contentSha256: null }])?.id).toBe("id-b")
    expect(pendingIdReplacement([
      { ...olderVerified, contentSha256: null },
      { ...newerUnverified, contentSha256: null },
    ])?.id).toBe("id-b")
  })

  it("never matches on a malformed digest, even an equal one", () => {
    const upper = olderVerified.contentSha256!.toUpperCase()
    expect(pendingIdReplacement([
      { ...olderVerified, contentSha256: upper },
      { ...newerUnverified, contentSha256: upper },
    ])?.id).toBe("id-b")
    expect(pendingIdReplacement([
      { ...olderVerified, contentSha256: "" },
      { ...newerUnverified, contentSha256: "" },
    ])?.id).toBe("id-b")
  })

  it("compares with the newest verified copy, not an older verified one", () => {
    const oldestVerified = copy({ id: "id-0", verified: true, createdAt: new Date("2026-07-19T08:00:00.000Z") })
    const backToOldest = { ...newerUnverified, contentSha256: oldestVerified.contentSha256 }
    expect(pendingIdReplacement([oldestVerified, olderVerified, backToOldest])?.id).toBe("id-b")
  })

  it("is decided by the newest unreviewed copy alone", () => {
    const newestSameBytes = copy({
      id: "id-c",
      createdAt: new Date("2026-07-22T08:00:00.000Z"),
      contentSha256: olderVerified.contentSha256,
    })
    expect(pendingIdReplacement([olderVerified, newerUnverified, newestSameBytes])).toBeNull()
    const newestOtherBytes = { ...newestSameBytes, contentSha256: digestOf("other") }
    expect(pendingIdReplacement([olderVerified, sameBytes, newestOtherBytes])?.id).toBe("id-c")
  })
})
