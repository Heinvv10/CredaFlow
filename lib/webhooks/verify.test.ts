import { createHmac } from "node:crypto"
import { describe, it, expect } from "vitest"
import { verifyTwilio, verifyBulkSms, verifyWaUnofficial, verifyWaba } from "./verify"

function twilioSign(fullUrl: string, params: Record<string, string>, secret: string): string {
  // Twilio: HMAC-SHA1 of (fullUrl + sortedParamKeys.map(k => k + params[k]).join("")), base64
  const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join("")
  return createHmac("sha1", secret).update(fullUrl + sorted).digest("base64")
}

describe("verifyTwilio", () => {
  const secret = "twilio-secret"
  const fullUrl = "https://staging.acme-lending.example/api/webhooks/twilio"
  const params = { From: "+27821234567", Body: "STOP", MessageSid: "SM123" }

  it("accepts a known-good X-Twilio-Signature", () => {
    const sig = twilioSign(fullUrl, params, secret)
    const headers = new Headers({ "x-twilio-signature": sig })
    expect(verifyTwilio({ fullUrl, formParams: params, headers, secret })).toEqual({ ok: true })
  })

  it("rejects a tampered body (BAD_HMAC)", () => {
    const sig = twilioSign(fullUrl, params, secret)
    const headers = new Headers({ "x-twilio-signature": sig })
    const tampered = { ...params, Body: "TAMPERED" }
    expect(verifyTwilio({ fullUrl, formParams: tampered, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })

  it("rejects when the X-Twilio-Signature header is missing", () => {
    const headers = new Headers()
    expect(verifyTwilio({ fullUrl, formParams: params, headers, secret })).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
    })
  })

  it("rejects when the secret is wrong", () => {
    const sig = twilioSign(fullUrl, params, "wrong-secret")
    const headers = new Headers({ "x-twilio-signature": sig })
    expect(verifyTwilio({ fullUrl, formParams: params, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })
})

describe("verifyBulkSms", () => {
  const secret = "bulksms-secret"
  const body = '{"event":"delivered","id":"abc123"}'

  it("accepts a known-good HMAC-SHA256 hex signature", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-bulksms-hmac": sig })
    expect(verifyBulkSms({ rawBody: body, headers, secret })).toEqual({ ok: true })
  })

  it("rejects a tampered body (BAD_HMAC)", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-bulksms-hmac": sig })
    expect(
      verifyBulkSms({ rawBody: body + "X", headers, secret })
    ).toEqual({ ok: false, reason: "BAD_HMAC" })
  })

  it("rejects when the x-bulksms-hmac header is missing", () => {
    expect(verifyBulkSms({ rawBody: body, headers: new Headers(), secret })).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
    })
  })

  it("rejects when the secret is wrong", () => {
    const sig = createHmac("sha256", "wrong").update(body).digest("hex")
    const headers = new Headers({ "x-bulksms-hmac": sig })
    expect(verifyBulkSms({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })
})

describe("verifyWaUnofficial", () => {
  const secret = "wa-unofficial-secret"
  const body = '{"from":"27821234567","text":"STOP"}'

  it("accepts a known-good HMAC-SHA256 hex signature", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-wa-signature": sig })
    expect(verifyWaUnofficial({ rawBody: body, headers, secret })).toEqual({ ok: true })
  })

  it("rejects when the x-wa-signature header is missing", () => {
    expect(verifyWaUnofficial({ rawBody: body, headers: new Headers(), secret })).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
    })
  })

  it("rejects a tampered body (BAD_HMAC)", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-wa-signature": sig })
    expect(
      verifyWaUnofficial({ rawBody: body + "X", headers, secret })
    ).toEqual({ ok: false, reason: "BAD_HMAC" })
  })
})

describe("verifyWaba", () => {
  const secret = "waba-app-secret"
  const body = '{"object":"whatsapp_business_account","entry":[]}'

  it("accepts a known-good X-Hub-Signature-256 (sha256= prefix)", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-hub-signature-256": `sha256=${hex}` })
    expect(verifyWaba({ rawBody: body, headers, secret })).toEqual({ ok: true })
  })

  it("rejects when the header is missing", () => {
    expect(verifyWaba({ rawBody: body, headers: new Headers(), secret })).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
    })
  })

  it("rejects when the sha256= prefix is missing", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex")
    // Meta always sends with the prefix; absence = malformed → BAD_HMAC, not MISSING_HEADER
    const headers = new Headers({ "x-hub-signature-256": hex })
    expect(verifyWaba({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })

  it("rejects a tampered body (BAD_HMAC)", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex")
    const headers = new Headers({ "x-hub-signature-256": `sha256=${hex}` })
    expect(
      verifyWaba({ rawBody: body + "X", headers, secret })
    ).toEqual({ ok: false, reason: "BAD_HMAC" })
  })

  it("rejects when the secret is wrong", () => {
    const hex = createHmac("sha256", "wrong").update(body).digest("hex")
    const headers = new Headers({ "x-hub-signature-256": `sha256=${hex}` })
    expect(verifyWaba({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })
})

describe("verifyWaUnofficial — wrong-secret symmetry", () => {
  it("rejects when the secret is wrong", () => {
    const secret = "wa-unofficial-secret"
    const body = '{"from":"27821234567","text":"STOP"}'
    const sig = createHmac("sha256", "wrong").update(body).digest("hex")
    const headers = new Headers({ "x-wa-signature": sig })
    expect(verifyWaUnofficial({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })
})

describe("safe comparison — embedded-whitespace / malformed-input rejection", () => {
  // Defence-in-depth tests for the timing-safe comparators behind verifyTwilio
  // (base64) and the body-HMAC verifiers (hex). The exploit class: Node's
  // `Buffer.from(str, "base64")` silently strips embedded whitespace, so a
  // signature like "ab cd" decodes to the same bytes as "abcd". The strict
  // character-class guards in verify.ts reject those strings before decode.
  const twilioFullUrl = "https://staging.acme-lending.example/api/webhooks/twilio"
  const twilioParams = { From: "+27821234567", Body: "STOP" }
  const twilioSecret = "twilio-secret"

  it("verifyTwilio rejects a base64 signature with embedded whitespace", () => {
    const goodSig = twilioSign(twilioFullUrl, twilioParams, twilioSecret)
    const tampered = goodSig.slice(0, 5) + " " + goodSig.slice(5)
    const headers = new Headers({ "x-twilio-signature": tampered })
    expect(
      verifyTwilio({ fullUrl: twilioFullUrl, formParams: twilioParams, headers, secret: twilioSecret })
    ).toEqual({ ok: false, reason: "BAD_HMAC" })
  })

  it("verifyBulkSms rejects a hex signature with embedded whitespace", () => {
    const secret = "bulksms-secret"
    const body = '{"event":"delivered"}'
    const goodSig = createHmac("sha256", secret).update(body).digest("hex")
    const tampered = goodSig.slice(0, 10) + " " + goodSig.slice(10)
    const headers = new Headers({ "x-bulksms-hmac": tampered })
    expect(verifyBulkSms({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })

  it("verifyWaba rejects a hex signature with non-hex characters", () => {
    const secret = "waba-app-secret"
    const body = '{"object":"whatsapp_business_account"}'
    const goodSig = createHmac("sha256", secret).update(body).digest("hex")
    const tampered = goodSig.slice(0, -2) + "zz"
    const headers = new Headers({ "x-hub-signature-256": `sha256=${tampered}` })
    expect(verifyWaba({ rawBody: body, headers, secret })).toEqual({
      ok: false,
      reason: "BAD_HMAC",
    })
  })
})
