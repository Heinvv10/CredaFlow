import { describe, expect, it } from "vitest"
import {
  mayReleaseMessageOperationId,
  messageOperationIdAfterChannelSelection,
  messageDeliveryOutcome,
  messageOperationIdAfterOutcome,
} from "./delivery-outcome"

describe("messageDeliveryOutcome", () => {
  it.each([
    ["SENT", "sent"],
    ["DELIVERED", "sent"],
    ["READ", "sent"],
    ["SIMULATED", "simulated"],
    ["QUEUED", "pending"],
    ["RETRYING", "pending"],
    ["FAILED", "not_sent"],
    ["FAILED_PERMANENT", "not_sent"],
    ["SUPPRESSED_BY_CONSENT", "not_sent"],
    ["EXPIRED", "not_sent"],
    ["BOUNCED", "not_sent"],
  ] as const)("projects %s as %s", (status, outcome) => {
    expect(messageDeliveryOutcome(status)).toBe(outcome)
  })
})

describe("mayReleaseMessageOperationId", () => {
  it("releases every definitive terminal success or local simulation", () => {
    expect(mayReleaseMessageOperationId("sent")).toBe(true)
    expect(mayReleaseMessageOperationId("simulated")).toBe(true)
    expect(mayReleaseMessageOperationId("simulated", true)).toBe(false)
    expect(mayReleaseMessageOperationId("pending")).toBe(false)
    expect(mayReleaseMessageOperationId("pending", true)).toBe(false)
    expect(mayReleaseMessageOperationId(undefined)).toBe(false)
  })

  it("retains one business key for every non-accepted or uncertain outcome", () => {
    for (const outcome of ["pending", undefined] as const) {
      expect(messageOperationIdAfterOutcome("operation-1", outcome)).toBe("operation-1")
    }
    expect(messageOperationIdAfterOutcome("operation-1", "pending", true)).toBe("operation-1")
    expect(messageOperationIdAfterOutcome("operation-1", "sent")).toBeNull()
    expect(messageOperationIdAfterOutcome("operation-1", "simulated")).toBeNull()
  })

  it("retains the key when the already-selected compose channel is clicked", () => {
    expect(messageOperationIdAfterChannelSelection("operation-1", "SMS", "SMS")).toBe("operation-1")
    expect(messageOperationIdAfterChannelSelection("operation-1", "SMS", "WHATSAPP")).toBeNull()
  })
})
