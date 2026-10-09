import { describe, expect, it } from "vitest"
import {
  allowedMessageReconciliationOutcomes,
  messagePresentationStatus,
  requiresMessageReconciliation,
} from "./reconciliation"

describe("message reconciliation presentation", () => {
  it("locks durable provider outcomes to their only truthful resolution", () => {
    expect(allowedMessageReconciliationOutcomes("ACCEPTED")).toEqual(["SENT"])
    expect(allowedMessageReconciliationOutcomes("SIMULATED")).toEqual(["SIMULATED"])
    expect(allowedMessageReconciliationOutcomes("AMBIGUOUS")).toEqual(["SENT", "SIMULATED", "NOT_SENT"])
    expect(allowedMessageReconciliationOutcomes("DISPATCHING")).toEqual(["SENT", "SIMULATED", "NOT_SENT"])
    expect(allowedMessageReconciliationOutcomes("RECONCILED_SENT")).toEqual([])
  })

  it("recognises explicit ambiguous and known-outcome holds", () => {
    expect(requiresMessageReconciliation({
      status: "QUEUED",
      dispatchState: "AMBIGUOUS",
    })).toBe(true)
    expect(requiresMessageReconciliation({
      status: "RETRYING",
      dispatchState: "AMBIGUOUS",
    })).toBe(false)
    expect(requiresMessageReconciliation({ status: "QUEUED", dispatchState: "ACCEPTED" })).toBe(true)
    expect(requiresMessageReconciliation({ status: "QUEUED", dispatchState: "SIMULATED" })).toBe(true)
    expect(requiresMessageReconciliation({ status: "QUEUED", dispatchState: null })).toBe(false)
  })

  it("returns an explicit virtual terminal status to polling clients", () => {
    expect(messagePresentationStatus({
      status: "QUEUED",
      dispatchState: "AMBIGUOUS",
    })).toBe("RECONCILIATION_REQUIRED")
    expect(messagePresentationStatus({ status: "DELIVERED", dispatchState: "ACCEPTED" })).toBe("DELIVERED")
  })

  it("surfaces only an expired persisted dispatch lease after a process crash", () => {
    const now = new Date("2026-07-22T15:00:00.000Z")
    const input = {
      status: "QUEUED",
      dispatchState: "DISPATCHING",
      dispatchLeaseExpiresAt: now,
    }
    expect(requiresMessageReconciliation(input, now)).toBe(true)
    expect(messagePresentationStatus(input, now)).toBe("RECONCILIATION_REQUIRED")
  })

  it("does not capture a live provider call even when its Message is old", () => {
    const now = new Date("2026-07-22T15:00:00.000Z")
    expect(requiresMessageReconciliation({
      status: "QUEUED",
      dispatchState: "DISPATCHING",
      dispatchLeaseExpiresAt: new Date(now.getTime() + 1),
    }, now)).toBe(false)
    expect(requiresMessageReconciliation({
      status: "QUEUED",
      dispatchState: null,
      dispatchLeaseExpiresAt: new Date(now.getTime() - 60_000),
    }, now)).toBe(false)
  })
})
