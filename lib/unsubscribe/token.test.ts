import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { signUnsubToken, verifyUnsubToken, type UnsubPayload } from "./token"

const SECRET = "test-unsub-secret"
const FAR_FUTURE_EXP = Date.now() + 90 * 24 * 60 * 60 * 1000

function basePayload(): UnsubPayload {
  return {
    contactId: "ct_abc",
    channel: "EMAIL",
    purpose: "MARKETING_GENERAL",
    exp: FAR_FUTURE_EXP,
  }
}

describe("signUnsubToken + verifyUnsubToken", () => {
  it("round-trips a valid payload", () => {
    const token = signUnsubToken(basePayload(), SECRET)
    const result = verifyUnsubToken(token, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.contactId).toBe("ct_abc")
      expect(result.payload.channel).toBe("EMAIL")
      expect(result.payload.purpose).toBe("MARKETING_GENERAL")
      expect(result.payload.exp).toBe(FAR_FUTURE_EXP)
    }
  })

  it("rejects a tampered payload (BAD_SIG)", () => {
    const token = signUnsubToken(basePayload(), SECRET)
    const [_payload, sig] = token.split(".")
    // Mutate the payload's contactId without re-signing
    const tampered = Buffer.from('{"contactId":"ct_OTHER","channel":"EMAIL","purpose":"MARKETING_GENERAL","exp":' + FAR_FUTURE_EXP + '}').toString("base64url")
    expect(verifyUnsubToken(`${tampered}.${sig}`, SECRET)).toEqual({ ok: false, reason: "BAD_SIG" })
  })

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubToken(basePayload(), "different-secret")
    expect(verifyUnsubToken(token, SECRET)).toEqual({ ok: false, reason: "BAD_SIG" })
  })

  it("rejects an expired token", () => {
    const expired = signUnsubToken({ ...basePayload(), exp: Date.now() - 1000 }, SECRET)
    expect(verifyUnsubToken(expired, SECRET)).toEqual({ ok: false, reason: "EXPIRED" })
  })

  it("rejects a malformed token (no dot)", () => {
    expect(verifyUnsubToken("not-a-token", SECRET)).toEqual({ ok: false, reason: "MALFORMED" })
  })

  it("rejects a token whose sig segment is not valid base64url (decodes to empty)", () => {
    // `Buffer.from("!!!", "base64url")` drops all non-base64url chars and
    // returns an empty buffer; the zero-length guard in safeCompareBase64url
    // catches this before reaching timingSafeEqual.
    expect(verifyUnsubToken("!!!.!!!", SECRET)).toEqual({ ok: false, reason: "MALFORMED" })
  })

  it("rejects a malformed token (payload not valid JSON)", () => {
    // Build a token with a valid HMAC but a body that is not valid JSON,
    // so the sig check passes and the JSON-parse step returns MALFORMED.
    const badPayload = Buffer.from("not json").toString("base64url")
    const realSig = Buffer.from(createHmac("sha256", SECRET).update(badPayload).digest()).toString("base64url")
    expect(verifyUnsubToken(`${badPayload}.${realSig}`, SECRET)).toEqual({ ok: false, reason: "MALFORMED" })
  })

  it("rejects a token with missing required fields", () => {
    // Sign with our own secret a payload that's missing `contactId`
    const incomplete = Buffer.from('{"channel":"EMAIL","purpose":"MARKETING_GENERAL","exp":' + FAR_FUTURE_EXP + '}').toString("base64url")
    const sig = Buffer.from(createHmac("sha256", SECRET).update(incomplete).digest()).toString("base64url")
    expect(verifyUnsubToken(`${incomplete}.${sig}`, SECRET)).toEqual({ ok: false, reason: "MALFORMED" })
  })
})
