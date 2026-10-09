import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { verifyStitchSignature } from "../../app/api/portal/payment/webhook/signature"

const SECRET = "test-secret"

describe("verifyStitchSignature — timing-safe HMAC", () => {
  it("returns true when signature matches the expected HMAC", () => {
    const body = "{\"event\":\"payment.completed\"}"
    const expected = createHmac("sha256", SECRET).update(body).digest("hex")
    expect(verifyStitchSignature({ body, signature: expected, secret: SECRET })).toBe(true)
  })

  it("returns false when signature is tampered (single byte difference)", () => {
    const body = "{\"event\":\"payment.completed\"}"
    const expected = createHmac("sha256", SECRET).update(body).digest("hex")
    const tampered = expected.slice(0, -1) + (expected.slice(-1) === "0" ? "1" : "0")
    expect(verifyStitchSignature({ body, signature: tampered, secret: SECRET })).toBe(false)
  })

  it("returns false on length mismatch without throwing", () => {
    expect(verifyStitchSignature({ body: "{}", signature: "short", secret: SECRET })).toBe(false)
  })

  it("returns false when signature is empty", () => {
    expect(verifyStitchSignature({ body: "{}", signature: "", secret: SECRET })).toBe(false)
  })

  it("returns false when secret is empty", () => {
    const body = "{}"
    const fake = createHmac("sha256", SECRET).update(body).digest("hex")
    expect(verifyStitchSignature({ body, signature: fake, secret: "" })).toBe(false)
  })
})
