import { describe, it, expect } from "vitest"
import { computeConsentTransition } from "./consent"

const ALL_FALSE = {
  creditBureauEnquiry: false,
  insuranceUnderwriting: false,
  smsMarketing: false,
  emailMarketing: false,
  thirdPartySharing: false,
  automatedDecisionMaking: false,
  withdrawnAt: null as Date | null,
}

const ALL_PROCESSING_GRANTED = {
  creditBureauEnquiry: true,
  insuranceUnderwriting: true,
  smsMarketing: false,
  emailMarketing: false,
  thirdPartySharing: true,
  automatedDecisionMaking: true,
  withdrawnAt: null as Date | null,
}

describe("computeConsentTransition", () => {
  it("marketing toggle off → on emits one CONSENT_PURPOSE_CHANGED", () => {
    const t = computeConsentTransition(
      ALL_PROCESSING_GRANTED,
      { smsMarketing: true },
      { actorId: "user-1" },
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0]).toMatchObject({
      action: "CONSENT_PURPOSE_CHANGED",
      purpose: "smsMarketing",
      from: false,
      to: true,
    })
    expect(t.updates).toMatchObject({ smsMarketing: true })
    expect(t.updates.withdrawnAt).toBeUndefined()
  })

  it("bulk withdrawal (all 4 processing true → false) emits CONSENT_WITHDRAWN and sets withdrawnAt", () => {
    const t = computeConsentTransition(
      ALL_PROCESSING_GRANTED,
      {
        creditBureauEnquiry: false,
        insuranceUnderwriting: false,
        thirdPartySharing: false,
        automatedDecisionMaking: false,
      },
      { actorId: "user-1", reason: "Client phoned to revoke" },
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0]).toMatchObject({
      action: "CONSENT_WITHDRAWN",
      reason: "Client phoned to revoke",
    })
    // Type-only narrowing — the preceding toMatchObject already verifies action at runtime.
    const withdrawnEvent = t.auditEvents[0] as Extract<(typeof t.auditEvents)[number], { action: "CONSENT_WITHDRAWN" }>
    expect(withdrawnEvent.purposes).toEqual(
      expect.arrayContaining([
        "creditBureauEnquiry",
        "insuranceUnderwriting",
        "thirdPartySharing",
        "automatedDecisionMaking",
      ]),
    )
    expect(t.updates.withdrawnAt).toBeInstanceOf(Date)
    expect(t.updates.withdrawnBy).toBe("user-1")
    expect(t.updates.creditBureauEnquiry).toBe(false)
  })

  it("bulk re-grant on a withdrawn row emits CONSENT_GRANTED and clears withdrawnAt", () => {
    const withdrawn = {
      ...ALL_FALSE,
      withdrawnAt: new Date("2026-01-01"),
    }
    const t = computeConsentTransition(
      withdrawn,
      {
        creditBureauEnquiry: true,
        insuranceUnderwriting: true,
        thirdPartySharing: true,
        automatedDecisionMaking: true,
      },
      { actorId: "user-1", reason: "Client re-consented in branch" },
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0]).toMatchObject({
      action: "CONSENT_GRANTED",
      reason: "Client re-consented in branch",
    })
    expect(t.updates.withdrawnAt).toBeNull()
    expect(t.updates.withdrawnBy).toBeNull()
    expect(t.updates.capturedAt).toBeInstanceOf(Date)
    expect(t.updates.capturedBy).toBe("user-1")
  })

  it("partial processing change (1 of 4) emits CONSENT_PURPOSE_CHANGED and does NOT touch withdrawnAt", () => {
    const t = computeConsentTransition(
      ALL_PROCESSING_GRANTED,
      { creditBureauEnquiry: false },
      { actorId: "user-1", reason: "Client opted out of bureau only" },
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0]).toMatchObject({
      action: "CONSENT_PURPOSE_CHANGED",
      purpose: "creditBureauEnquiry",
      from: true,
      to: false,
    })
    expect(t.updates.withdrawnAt).toBeUndefined()
  })

  it("marketing-and-processing mixed emits two CONSENT_PURPOSE_CHANGED rows, NOT a CONSENT_WITHDRAWN", () => {
    const t = computeConsentTransition(
      { ...ALL_PROCESSING_GRANTED, smsMarketing: true },
      { creditBureauEnquiry: false, smsMarketing: false },
      { actorId: "user-1", reason: "Client phoned" },
    )
    expect(t.auditEvents).toHaveLength(2)
    expect(t.auditEvents.map((e) => e.action)).toEqual([
      "CONSENT_PURPOSE_CHANGED",
      "CONSENT_PURPOSE_CHANGED",
    ])
    expect(t.updates.withdrawnAt).toBeUndefined()
  })

  it("no-op write emits zero audit events and empty updates", () => {
    const t = computeConsentTransition(
      ALL_PROCESSING_GRANTED,
      { creditBureauEnquiry: true, insuranceUnderwriting: true },
      { actorId: "user-1" },
    )
    expect(t.auditEvents).toEqual([])
    expect(Object.keys(t.updates)).toHaveLength(0)
  })

  it("partial re-grant on a withdrawn row emits CONSENT_PURPOSE_CHANGED but does NOT clear withdrawnAt", () => {
    const withdrawn = {
      ...ALL_FALSE,
      withdrawnAt: new Date("2026-01-01"),
    }
    const t = computeConsentTransition(
      withdrawn,
      { creditBureauEnquiry: true }, // only 1 of 4 — not a bulk re-grant
      { actorId: "user-1", reason: "Client re-consented to bureau only" },
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0]).toMatchObject({
      action: "CONSENT_PURPOSE_CHANGED",
      purpose: "creditBureauEnquiry",
      from: false,
      to: true,
    })
    expect(t.updates.withdrawnAt).toBeUndefined() // CRITICAL: row stays withdrawn until full re-grant
    expect(t.updates.capturedAt).toBeUndefined()
  })

  it("fresh-row all-false → all-true emits four CONSENT_PURPOSE_CHANGED, NOT a CONSENT_GRANTED", () => {
    const t = computeConsentTransition(
      ALL_FALSE,
      {
        creditBureauEnquiry: true,
        insuranceUnderwriting: true,
        thirdPartySharing: true,
        automatedDecisionMaking: true,
      },
      { actorId: "user-1", reason: "Manual capture" },
    )
    expect(t.auditEvents).toHaveLength(4)
    expect(t.auditEvents.every((e) => e.action === "CONSENT_PURPOSE_CHANGED")).toBe(true)
    expect(t.updates.capturedAt).toBeUndefined()
  })

  it("bulk withdrawal with actorId: null sets withdrawnBy: null", () => {
    const t = computeConsentTransition(
      ALL_PROCESSING_GRANTED,
      {
        creditBureauEnquiry: false,
        insuranceUnderwriting: false,
        thirdPartySharing: false,
        automatedDecisionMaking: false,
      },
      { actorId: null }, // self-service path — no staff actor
    )
    expect(t.auditEvents).toHaveLength(1)
    expect(t.auditEvents[0].action).toBe("CONSENT_WITHDRAWN")
    expect(t.updates.withdrawnBy).toBeNull()
    expect(t.updates.withdrawnAt).toBeInstanceOf(Date)
  })
})
