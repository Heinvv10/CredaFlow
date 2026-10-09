import { describe, expect, it } from "vitest"
import { leadMessageHeadline } from "./lead-message-headline"

describe("leadMessageHeadline", () => {
  it("never claims a simulated outbound message was sent", () => {
    expect(leadMessageHeadline({
      channelLabel: "WhatsApp",
      direction: "OUTBOUND",
      status: "SIMULATED",
    })).toBe("WhatsApp simulated — not sent")
  })

  it.each([
    ["QUEUED", "SMS queued"],
    ["RETRYING", "SMS retrying"],
    ["FAILED_PERMANENT", "SMS not sent"],
    ["SENT", "SMS sent"],
    ["DELIVERED", "SMS sent"],
  ])("derives outbound %s copy from the durable status", (status, expected) => {
    expect(leadMessageHeadline({
      channelLabel: "SMS",
      direction: "OUTBOUND",
      status,
    })).toBe(expected)
  })

  it("keeps inbound copy independent of outbound status names", () => {
    expect(leadMessageHeadline({
      channelLabel: "Email",
      direction: "INBOUND",
      status: "READ",
    })).toBe("Email received")
  })
})
