import { describe, expect, it } from "vitest"
import { redactDeliveryError } from "./request"

describe("redactDeliveryError", () => {
  it("keeps the reason but masks the recipient and any code or number", () => {
    const raw = "send blocked for thandi@example.invalid (to 27821234567): body 'code 123456' rejected; WhatsApp Cloud 400"
    const redacted = redactDeliveryError(raw)
    expect(redacted).toBe("send blocked for [email] (to [digits]): body 'code [digits]' rejected; WhatsApp Cloud 400")
    expect(redacted).not.toMatch(/thandi|27821234567|123456/)
  })

  it("caps the length", () => {
    expect(redactDeliveryError("x".repeat(1000))).toHaveLength(300)
  })
})
