import { describe, expect, it } from "vitest"
import {
  OUTAGE_APPLICATIONS,
  createOutageExceptionEvidence,
  isOutageIncidentId,
  normalizeSastDateOnly,
  outageApplicationIdsForIncident,
  outageApplicationPolicy,
  outageIncidentIds,
  parseOutageExceptionEvidence,
} from "./outage-exception"

/**
 * The allow-list is intentionally EMPTY in this product. Every test here proves
 * a refusal: no application, incident, payout date or evidence payload is
 * reconcilable. The ids are synthetic.
 */
const APPLICATION_ID = "test-application-0001"
const APPLICATION_REFERENCE = "APP-TEST-0001"
const INCIDENT_ID = "test-incident-0001"

const operator = {
  reconciledById: "super-admin-1",
  reconciledByEmail: "operator@example.test",
  reconciledAt: new Date("2026-01-02T09:30:00.000Z"),
  managementApprovalNote:
    "Test Approver approved the formal outage reconciliation.",
}

/** A payload with every field the evidence shape requires, well formed. */
const wellFormedEvidence = {
  kind: "DISBURSEMENT_OUTAGE_EXCEPTION",
  version: "disbursement-outage-exception-v1",
  incidentId: INCIDENT_ID,
  applicationId: APPLICATION_ID,
  applicationReference: APPLICATION_REFERENCE,
  actualPayoutDate: "2026-01-01",
  timestampPrecision: "DATE",
  managementApprovedBy: "Test Approver",
  managementApprovalNote: operator.managementApprovalNote,
  waivedPreconditions: ["verified_banking"],
  reconciledById: operator.reconciledById,
  reconciledByEmail: operator.reconciledByEmail,
  reconciledAt: operator.reconciledAt.toISOString(),
  duplicatePayoutSuppressed: true,
}

describe("the outage allow-list", () => {
  it("is empty: no application and no incident is reconcilable", () => {
    expect(Object.keys(OUTAGE_APPLICATIONS)).toEqual([])
    expect(outageIncidentIds()).toEqual([])
  })
})

describe("outageApplicationPolicy", () => {
  it("grants no policy to any application", () => {
    expect(outageApplicationPolicy(APPLICATION_ID)).toBeNull()
    expect(outageApplicationPolicy(APPLICATION_REFERENCE)).toBeNull()
    expect(outageApplicationPolicy("")).toBeNull()
  })

  it("does not treat inherited object keys as policies", () => {
    expect(outageApplicationPolicy("constructor")).toBeNull()
    expect(outageApplicationPolicy("__proto__")).toBeNull()
  })
})

describe("incidents", () => {
  it("grants no cohort to any incident", () => {
    expect(outageApplicationIdsForIncident(INCIDENT_ID)).toEqual([])
    expect(isOutageIncidentId(INCIDENT_ID)).toBe(false)
    expect(isOutageIncidentId("")).toBe(false)
  })
})

describe("normalizeSastDateOnly", () => {
  // An arbitrary date must never become a disbursement timestamp, and with an
  // empty allow-list no date is declared at all.
  it("refuses every date", () => {
    for (const date of ["2026-01-01", "1970-01-01", "not-a-date", ""]) {
      expect(() => normalizeSastDateOnly(date))
        .toThrow(/approved outage payout date/i)
    }
  })
})

describe("outage exception evidence", () => {
  it("cannot be created for any application", () => {
    expect(() => createOutageExceptionEvidence({
      applicationId: APPLICATION_ID,
      applicationReference: APPLICATION_REFERENCE,
      ...operator,
    })).toThrow(/application reference does not match/i)
  })

  it("is refused at the policy check before the note is even read", () => {
    expect(() => createOutageExceptionEvidence({
      applicationId: APPLICATION_ID,
      applicationReference: APPLICATION_REFERENCE,
      ...operator,
      managementApprovalNote: "too short",
    })).toThrow(/application reference does not match/i)
  })

  it("does not parse a well-formed payload for an application with no policy", () => {
    expect(parseOutageExceptionEvidence(wellFormedEvidence)).toBeNull()
  })

  it("rejects payloads that are not evidence at all", () => {
    expect(parseOutageExceptionEvidence(null)).toBeNull()
    expect(parseOutageExceptionEvidence([])).toBeNull()
    expect(parseOutageExceptionEvidence({
      ...wellFormedEvidence,
      kind: "SOMETHING_ELSE",
    })).toBeNull()
  })
})
