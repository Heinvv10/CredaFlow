import { describe, it, expect } from "vitest"
import { matchDecidedHistory } from "./decided-history"

const baseAudit = {
  id: "audit_1",
  entityId: "event_1",
  userEmail: "admin@lender.example",
  createdAt: new Date("2026-08-05T10:00:00.000Z"),
  newValue: { commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Approved in queue" },
}

const eventsById = new Map([
  [
    "event_1",
    {
      id: "event_1",
      eventType: "CONVERTED",
      commissionCents: 3000,
      code: { code: "TF-001", label: null, agent: { displayName: "Jabu" } },
      lead: null,
    },
  ],
])

describe("matchDecidedHistory", () => {
  it("joins an audit row to its event by entityId", () => {
    const [row] = matchDecidedHistory([baseAudit], eventsById)
    expect(row.event?.id).toBe("event_1")
    expect(row.decidedByEmail).toBe("admin@lender.example")
    expect(row.decidedAt).toBe("2026-08-05T10:00:00.000Z")
  })

  it("pulls the decision outcome out of the audit row's newValue JSON", () => {
    const [row] = matchDecidedHistory([baseAudit], eventsById)
    expect(row.commissionStatus).toBe("PAYABLE")
    expect(row.qualityFlag).toBe("APPROVED")
    expect(row.decisionNote).toBe("Approved in queue")
  })

  // Degrade, don't drop: the decision itself is the legal record and must stay
  // visible even if the underlying event row is gone (hard-deleted or the join
  // simply missed it) — same philosophy as resolveBorrower returning null
  // rather than throwing.
  it("keeps the audit row with event: null when the event cannot be found", () => {
    const [row] = matchDecidedHistory([baseAudit], new Map())
    expect(row.event).toBeNull()
    expect(row.decidedByEmail).toBe("admin@lender.example")
  })

  it("keeps the audit row with event: null when entityId is null", () => {
    const [row] = matchDecidedHistory([{ ...baseAudit, entityId: null }], eventsById)
    expect(row.event).toBeNull()
  })

  it("tolerates a malformed or missing newValue rather than throwing", () => {
    const [row1] = matchDecidedHistory([{ ...baseAudit, newValue: null }], eventsById)
    expect(row1.commissionStatus).toBeNull()
    expect(row1.qualityFlag).toBeNull()
    expect(row1.decisionNote).toBeNull()

    const [row2] = matchDecidedHistory([{ ...baseAudit, newValue: "not an object" }], eventsById)
    expect(row2.commissionStatus).toBeNull()

    const [row3] = matchDecidedHistory([{ ...baseAudit, newValue: [1, 2, 3] }], eventsById)
    expect(row3.commissionStatus).toBeNull()
  })

  it("preserves audit order (caller controls sort, this only joins)", () => {
    const older = { ...baseAudit, id: "audit_0", createdAt: new Date("2026-08-01T00:00:00.000Z") }
    const rows = matchDecidedHistory([baseAudit, older], eventsById)
    expect(rows.map((r) => r.auditId)).toEqual(["audit_1", "audit_0"])
  })

  it("returns an empty array for an empty audit list", () => {
    expect(matchDecidedHistory([], eventsById)).toEqual([])
  })
})
