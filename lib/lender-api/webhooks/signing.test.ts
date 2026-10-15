import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { generateWebhookSecret, signWebhookBody, verifyWebhookSignature } from "./signing"
import { MAX_ATTEMPTS, nextAttemptAfter, parseWebhookEvents } from "./events"

const secret = generateWebhookSecret()
const body = JSON.stringify({ id: "evt_1", type: "payment.received", data: { amount: 100 } })

describe("webhook signatures", () => {
  it("signs t.body with HMAC-SHA256 under the endpoint secret", () => {
    const header = signWebhookBody(secret, body, 1_760_000_000)
    const expected = createHmac("sha256", secret).update(`1760000000.${body}`).digest("hex")
    expect(header).toBe(`t=1760000000,v1=${expected}`)
    expect(verifyWebhookSignature(secret, header, body, { now: 1_760_000_000 })).toBe(true)
  })

  it("rejects a changed body, another secret, a stale timestamp and junk", () => {
    const header = signWebhookBody(secret, body, 1_760_000_000)
    expect(verifyWebhookSignature(secret, header, body.replace("100", "1000"), { now: 1_760_000_000 })).toBe(false)
    expect(verifyWebhookSignature(generateWebhookSecret(), header, body, { now: 1_760_000_000 })).toBe(false)
    expect(verifyWebhookSignature(secret, header, body, { now: 1_760_000_000 + 301 })).toBe(false)
    expect(verifyWebhookSignature(secret, "t=1760000000,v1=zz", body, { now: 1_760_000_000 })).toBe(false)
    expect(verifyWebhookSignature(secret, null, body)).toBe(false)
  })

  it("generates distinct secrets", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(generateWebhookSecret()).not.toBe(secret)
  })
})

describe("webhook retry schedule", () => {
  const now = new Date("2026-10-14T10:00:00Z")
  it("backs off, then gives up after the last attempt", () => {
    expect(nextAttemptAfter(1, now)!.getTime() - now.getTime()).toBe(60_000)
    expect(nextAttemptAfter(2, now)!.getTime() - now.getTime()).toBe(300_000)
    expect(nextAttemptAfter(MAX_ATTEMPTS - 1, now)!.getTime() - now.getTime()).toBe(86_400_000)
    expect(nextAttemptAfter(MAX_ATTEMPTS, now)).toBeNull()
  })
  it("parses event subscriptions", () => {
    expect(parseWebhookEvents(["loan.disbursed", "loan.disbursed"])).toEqual(["loan.disbursed"])
    expect(parseWebhookEvents(["loan.created"])).toBeNull()
    expect(parseWebhookEvents([])).toBeNull()
  })
})
