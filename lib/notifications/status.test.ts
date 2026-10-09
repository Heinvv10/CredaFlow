import { describe, expect, it } from "vitest"
import {
  notificationLogStatusFromMessage,
  notificationLogStatusFromProviderResult,
} from "./status"

describe("notification delivery status", () => {
  it("never aliases a simulated Message to sent", () => {
    expect(notificationLogStatusFromMessage("SIMULATED")).toBe("simulated")
    expect(notificationLogStatusFromMessage("SENT")).toBe("sent")
  })

  it("projects idempotent replays without inventing a delivery outcome", () => {
    expect(notificationLogStatusFromMessage("QUEUED")).toBe("pending")
    expect(notificationLogStatusFromMessage("RETRYING")).toBe("pending")
    expect(notificationLogStatusFromMessage("FAILED_PERMANENT")).toBe("failed")
    expect(() => notificationLogStatusFromMessage("UNKNOWN")).toThrow(/unrecognised status/i)
  })

  it("never aliases a dry-run provider result to sent", () => {
    expect(notificationLogStatusFromProviderResult({ ok: true, simulated: true })).toBe("simulated")
    expect(notificationLogStatusFromProviderResult({ ok: true })).toBe("sent")
    expect(notificationLogStatusFromProviderResult({ ok: false, simulated: true })).toBe("failed")
  })

  it("projects an ambiguous legacy provider outcome as review required", () => {
    expect(notificationLogStatusFromProviderResult({
      ok: false,
      providerOutcome: "AMBIGUOUS",
    })).toBe("review_required")
    expect(notificationLogStatusFromProviderResult({
      ok: false,
      providerOutcome: "DEFINITELY_REJECTED",
    })).toBe("failed")
    expect(notificationLogStatusFromProviderResult({
      ok: true,
      providerOutcome: "AMBIGUOUS",
    })).toBe("review_required")
    expect(notificationLogStatusFromProviderResult({
      ok: true,
      providerOutcome: "DEFINITELY_REJECTED",
    })).toBe("failed")
  })
})
