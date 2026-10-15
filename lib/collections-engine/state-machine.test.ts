import { describe, expect, it } from "vitest"
import { canTransition, fromProviderStatus, MANDATE_TRANSITIONS } from "./state-machine"

describe("mandate state machine", () => {
  it("walks create → submitting → pending registration → pending auth → active → suspended → cancelled", () => {
    expect(canTransition("CREATED", "SUBMITTING")).toBe(true)
    expect(canTransition("SUBMITTING", "PENDING_REGISTRATION")).toBe(true)
    expect(canTransition("PENDING_REGISTRATION", "PENDING_AUTH")).toBe(true)
    expect(canTransition("PENDING_AUTH", "ACTIVE")).toBe(true)
    expect(canTransition("ACTIVE", "SUSPENDED")).toBe(true)
    expect(canTransition("SUSPENDED", "CANCELLED")).toBe(true)
  })

  it("lets a synchronous rail answer the submission directly", () => {
    for (const to of ["PENDING_AUTH", "ACTIVE", "REJECTED"] as const) expect(canTransition("SUBMITTING", to)).toBe(true)
  })

  it("returns a failed submission to CREATED for a retry, and only from SUBMITTING", () => {
    expect(canTransition("SUBMITTING", "CREATED")).toBe(true)
    expect(canTransition("PENDING_AUTH", "CREATED")).toBe(false)
  })

  it("never calls the provider without a claim: CREATED goes only to SUBMITTING or CANCELLED", () => {
    expect(MANDATE_TRANSITIONS.CREATED).toEqual(["SUBMITTING", "CANCELLED"])
  })

  it("lets authorisation end in rejection or expiry", () => {
    expect(canTransition("PENDING_AUTH", "REJECTED")).toBe(true)
    expect(canTransition("PENDING_AUTH", "EXPIRED")).toBe(true)
    expect(canTransition("PENDING_REGISTRATION", "REJECTED")).toBe(true)
  })

  it("never re-activates a suspended mandate: the scheme requires a fresh one", () => {
    expect(canTransition("SUSPENDED", "ACTIVE")).toBe(false)
  })

  it("treats rejected, expired and cancelled as terminal", () => {
    for (const s of ["REJECTED", "EXPIRED", "CANCELLED"] as const) {
      expect(MANDATE_TRANSITIONS[s]).toEqual([])
    }
  })

  it("never skips authorisation backwards or to a state it cannot reach", () => {
    expect(canTransition("ACTIVE", "PENDING_AUTH")).toBe(false)
    expect(canTransition("CREATED", "SUSPENDED")).toBe(false)
    expect(canTransition("CREATED", "ACTIVE")).toBe(false)
    expect(canTransition("ACTIVE", "ACTIVE")).toBe(false)
  })

  it("maps provider statuses onto engine statuses", () => {
    expect(fromProviderStatus("AUTHENTICATED")).toBe("ACTIVE")
    expect(fromProviderStatus("PENDING_REGISTRATION")).toBe("PENDING_REGISTRATION")
    expect(fromProviderStatus("PENDING_AUTH")).toBe("PENDING_AUTH")
    expect(fromProviderStatus("REJECTED")).toBe("REJECTED")
    expect(fromProviderStatus("EXPIRED")).toBe("EXPIRED")
    expect(fromProviderStatus("SUSPENDED")).toBe("SUSPENDED")
    expect(fromProviderStatus("CANCELLED")).toBe("CANCELLED")
  })
})
