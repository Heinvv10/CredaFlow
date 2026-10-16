import { describe, expect, it } from "vitest"
import { resolveCurrentIdDocument, selectUsableIdDocument } from "./usable-id-document"

const SHA = "de55ee75641f3f62e5649ac5156746177ae35de35135597f7fb11d08368134ce"
const SHA2 = "1eb68864b31287e63085d5de00d8860aea0d5e8bd073e8791924f4ffd816ba71"

function doc(over: Partial<Parameters<typeof selectUsableIdDocument>[0][number]> = {}) {
  return {
    id: "d1",
    docType: "ID_COPY",
    verified: true,
    contentSha256: SHA,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
  }
}

describe("selectUsableIdDocument", () => {
  it("ignores a stale ID copy with no stored content and takes the usable one", () => {
    // The defect this exists for: a client with an older ID copy carrying
    // contentSha256 = NULL and two later verified copies with real digests.
    // Taking the FIRST row refuses the in-person verification — and therefore
    // the disbursement — of a client who has two perfectly good ID documents
    // on file.
    const chosen = selectUsableIdDocument([
      doc({ id: "seeded-no-content", contentSha256: null, createdAt: new Date("2026-05-09T15:15:34Z") }),
      doc({ id: "reupload-1", contentSha256: SHA, createdAt: new Date("2026-08-01T04:52:50Z") }),
      doc({ id: "reupload-2", contentSha256: SHA2, createdAt: new Date("2026-08-01T04:55:29Z") }),
    ])
    expect(chosen?.id).toBe("reupload-2")
  })

  it("refuses when the NEWEST verified copy has no stored content", () => {
    // Deliberately NOT a fallback to the older good copy. Every reader of the
    // attestation — readCompositeKycState and the Postgres function
    // subject_has_in_person_kyc_verification — takes the newest
    // verified row and validates ITS digest. Recording an attestation against
    // an older row would produce one the database refuses to honour at payout:
    // silently worse than refusing to record it here.
    const chosen = selectUsableIdDocument([
      doc({ id: "good-older", contentSha256: SHA, createdAt: new Date("2026-01-01T00:00:00Z") }),
      doc({ id: "broken-newest", contentSha256: null, createdAt: new Date("2026-07-01T00:00:00Z") }),
    ])
    expect(chosen).toBeNull()
  })

  it("breaks a same-timestamp tie by id DESC, as the readers do", () => {
    const same = new Date("2026-07-01T00:00:00Z")
    const chosen = selectUsableIdDocument([
      doc({ id: "aaa", contentSha256: SHA, createdAt: same }),
      doc({ id: "zzz", contentSha256: SHA2, createdAt: same }),
    ])
    expect(chosen?.id).toBe("zzz")
  })

  it("prefers the most recent usable copy", () => {
    const chosen = selectUsableIdDocument([
      doc({ id: "older", createdAt: new Date("2026-01-01T00:00:00Z") }),
      doc({ id: "newer", contentSha256: SHA2, createdAt: new Date("2026-07-01T00:00:00Z") }),
    ])
    expect(chosen?.id).toBe("newer")
  })

  it("ignores unverified copies even when they are newer", () => {
    // A newer but UNVERIFIED upload must not displace the verified one — that
    // would let an unreviewed document carry an identity attestation.
    const chosen = selectUsableIdDocument([
      doc({ id: "verified-older", createdAt: new Date("2026-01-01T00:00:00Z") }),
      doc({ id: "unverified-newer", verified: false, createdAt: new Date("2026-07-01T00:00:00Z") }),
    ])
    expect(chosen?.id).toBe("verified-older")
  })

  it("ignores documents that are not ID copies", () => {
    const chosen = selectUsableIdDocument([
      doc({ id: "payslip", docType: "PAYSLIP" }),
      doc({ id: "bank", docType: "BANK_STATEMENT" }),
    ])
    expect(chosen).toBeNull()
  })

  it("returns null when every ID copy is unusable — the case the error describes", () => {
    expect(
      selectUsableIdDocument([
        doc({ id: "no-content", contentSha256: null }),
        doc({ id: "unverified", verified: false }),
        doc({ id: "bad-digest", contentSha256: "not-a-sha" }),
      ]),
    ).toBeNull()
  })

  it("returns the single usable copy without needing a timestamp", () => {
    // A narrowed `select` may omit createdAt; that must not throw or refuse.
    const chosen = selectUsableIdDocument([doc({ id: "only", createdAt: undefined })])
    expect(chosen?.id).toBe("only")
  })

  it("still chooses deterministically when timestamps are missing", () => {
    const chosen = selectUsableIdDocument([
      doc({ id: "a", createdAt: undefined }),
      doc({ id: "b", contentSha256: SHA2, createdAt: undefined }),
    ])
    expect(chosen?.id).toBe("b")
  })
})

describe("resolveCurrentIdDocument", () => {
  const copy = (id: string, day: number, over: { verified?: boolean; sha?: string | null; rejected?: boolean } = {}) => ({
    id,
    verified: over.verified ?? false,
    contentSha256: over.sha === undefined ? SHA : over.sha,
    createdAt: new Date(Date.UTC(2026, 7, day)),
    verificationRejectedAt: over.rejected ? new Date(Date.UTC(2026, 7, day)) : null,
  })
  const resolve = (...copies: ReturnType<typeof copy>[]) => resolveCurrentIdDocument(copies)?.id ?? null

  it("resolves an unverified identical re-upload to the verified copy it repeats", () => {
    expect(resolve(copy("verified", 1, { verified: true }), copy("twin", 2))).toBe("verified")
  })

  it("keeps a re-upload of other bytes as the current copy", () => {
    expect(resolve(copy("verified", 1, { verified: true }), copy("other", 2, { sha: SHA2 }))).toBe("other")
  })

  it("never matches a missing digest, on either side", () => {
    expect(resolve(copy("verified", 1, { verified: true }), copy("no-digest", 2, { sha: null }))).toBe("no-digest")
    expect(resolve(copy("verified", 1, { verified: true, sha: null }), copy("no-digest", 2, { sha: null }))).toBe("no-digest")
  })

  it("never matches a malformed digest", () => {
    const upper = SHA.toUpperCase()
    expect(resolve(copy("verified", 1, { verified: true, sha: upper }), copy("twin", 2, { sha: upper }))).toBe("twin")
  })

  it("matches the newest verified copy only, not an older one", () => {
    expect(resolve(
      copy("old", 1, { verified: true }),
      copy("current", 2, { verified: true, sha: SHA2 }),
      copy("stale-twin", 3),
    )).toBe("stale-twin")
  })

  it("skips a rejected copy and has nothing to resolve without a verified one", () => {
    expect(resolve(copy("verified", 1, { verified: true }), copy("twin", 2), copy("refused", 3, { sha: SHA2, rejected: true }))).toBe("verified")
    expect(resolve(copy("first", 1), copy("second", 2))).toBe("second")
    expect(resolve(copy("refused", 1, { rejected: true }))).toBeNull()
  })

  it("orders a createdAt tie by id, as the readers do", () => {
    expect(resolve(copy("a-verified", 1, { verified: true }), copy("b-twin", 1))).toBe("a-verified")
    expect(resolve(copy("b-verified", 1, { verified: true }), copy("a-older", 1, { sha: SHA2 }))).toBe("b-verified")
  })
})
