import { describe, expect, it } from "vitest"
import {
  documentBytesMatchSha256,
  isSha256Digest,
  sha256DocumentBytes,
} from "./content-integrity"

describe("document content integrity", () => {
  const pdf = Buffer.from("%PDF-1.4 synthetic agreement")
  const digest = "373e7bcbdd0fa19f699d8f715da12dbadc76a7646050211ccb4f5da80177c259"

  it("produces a stable lowercase SHA-256 digest", () => {
    expect(sha256DocumentBytes(pdf)).toBe(digest)
    expect(isSha256Digest(digest)).toBe(true)
  })

  it("rejects changed bytes and malformed digests", () => {
    expect(documentBytesMatchSha256(pdf, digest)).toBe(true)
    expect(documentBytesMatchSha256(Buffer.from(`${pdf} changed`), digest)).toBe(false)
    expect(documentBytesMatchSha256(pdf, digest.toUpperCase())).toBe(false)
    expect(documentBytesMatchSha256(pdf, null)).toBe(false)
  })
})
