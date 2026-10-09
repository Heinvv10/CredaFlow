import { describe, expect, it } from "vitest"
import { readKnownAcceptedDispatchEvidence } from "./known-dispatch-evidence"

function knownError(over: Record<string, unknown> = {}) {
  return Object.assign(new Error("terminal writes failed"), {
    name: "KnownDispatchPersistenceError",
    outcome: "PROVIDER_ACCEPTED",
    providerAcceptedAt: new Date("2026-07-19T10:00:00.000Z"),
    evidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000001",
    evidenceAuditWriteError: undefined,
    ...over,
  })
}

describe("readKnownAcceptedDispatchEvidence", () => {
  it("preserves acceptance time and request-scoped evidence", () => {
    expect(readKnownAcceptedDispatchEvidence(knownError())).toEqual({
      acceptedAt: new Date("2026-07-19T10:00:00.000Z"),
      providerEvidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000001",
      persistenceWarning: "Provider accepted the notice, but the terminal Message state could not be persisted.",
      emergencyAuditPersisted: true,
    })
  })

  it("fails closed without a timestamp or provider-scoped reference", () => {
    expect(readKnownAcceptedDispatchEvidence(knownError({ providerAcceptedAt: undefined }))).toBeNull()
    expect(readKnownAcceptedDispatchEvidence(knownError({ evidenceReference: undefined }))).toBeNull()
    expect(readKnownAcceptedDispatchEvidence(new Error("unknown"))).toBeNull()
  })

  it("records when even the emergency audit was unavailable", () => {
    expect(readKnownAcceptedDispatchEvidence(knownError({
      providerMessageId: "smtp-message-1",
      evidenceReference: undefined,
      evidenceAuditWriteError: new Error("audit unavailable"),
    }))).toEqual(expect.objectContaining({
      providerMessageId: "smtp-message-1",
      emergencyAuditPersisted: false,
    }))
  })
})
