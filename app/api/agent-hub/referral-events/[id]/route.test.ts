import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const authGuardMock = vi.fn()
const tenantContextMock = vi.fn()
const logAuditMock = vi.fn()
const eventFindFirst = vi.fn()
const eventUpdateMany = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => authGuardMock(...args) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (tenant: unknown) => Promise<unknown>) => tenantContextMock(req, cb) }))
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => logAuditMock(...args) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralEvent: {
      findFirst: (args: unknown) => eventFindFirst(args),
      updateMany: (args: unknown) => eventUpdateMany(args),
    },
  },
}))

import { PATCH } from "./route"

function req(body: unknown) {
  return new NextRequest("https://staging.acme-lending.example/api/agent-hub/referral-events/event_1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const existing = {
  id: "event_1",
  tenantId: "tenant_acme",
  commissionStatus: "PENDING",
  qualityFlag: null,
  metadata: { reference: "TF-123" },
}

describe("PATCH /api/agent-hub/referral-events/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authGuardMock.mockResolvedValue({ user: { id: "user_1", email: "ops@example.com", role: "LOAN_ADMIN" } })
    tenantContextMock.mockImplementation((_req, cb) => cb({ id: "tenant_acme" }))
    eventFindFirst.mockResolvedValue(existing)
    eventUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("marks a pending referral event payable with a decision note and audit", async () => {
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Lead passed payout checks" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.commissionStatus).toBe("PAYABLE")
    expect(eventFindFirst).toHaveBeenCalledWith({ where: { id: "event_1", tenantId: "tenant_acme" } })
    expect(eventUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "event_1", tenantId: "tenant_acme", commissionStatus: { not: "REVERSED" } },
      data: {
        commissionStatus: "PAYABLE",
        qualityFlag: "APPROVED",
        metadata: {
          reference: "TF-123",
          lastDecision: expect.objectContaining({ note: "Lead passed payout checks", byUserId: "user_1", commissionStatus: "PAYABLE", qualityFlag: "APPROVED" }),
        },
      },
    })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "REFERRAL_EVENT_DECIDED", entityId: "event_1" }))
  })

  it("rejects invalid commission statuses without updating", async () => {
    const res = await PATCH(req({ commissionStatus: "PAID_NOW" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain("Invalid commission status")
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects mutating a commission that has already been reversed", async () => {
    eventFindFirst.mockResolvedValue({ ...existing, commissionStatus: "REVERSED" })
    eventUpdateMany.mockResolvedValue({ count: 0 })

    // Carries a decisionNote so this reaches the reversal guard: without one it
    // now short-circuits on the required-note check below and this test would
    // stop exercising the REVERSED path it exists for.
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Checked — not a duplicate" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain("reversed")
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  // The control is the ROUTE, not the panel. A decision releases or withholds
  // an agent's money and AuditLog.newValue.decisionNote is the only durable
  // record of why — so a status/flag change with no reason must not land at
  // all. Previously a missing note made cleanNullable return undefined, which
  // skipped lastDecision while the status change still succeeded.
  it("refuses a status change with no decisionNote at all", async () => {
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe("A decision note is required when changing commission status or quality flag.")
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  // Distinct from the case above: an empty string reached cleanNullable's
  // `text || null` branch, so lastDecision WAS written — with note: null.
  it("refuses a status change with an empty decisionNote", async () => {
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe("A decision note is required when changing commission status or quality flag.")
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses a whitespace-only decisionNote", async () => {
    const res = await PATCH(req({ commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "   \n\t " }), { params: Promise.resolve({ id: "event_1" }) })

    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  // A qualityFlag-only change is still a decision about the row, so it needs a
  // reason too — the guard must not key on commissionStatus alone.
  it("refuses a qualityFlag-only change with no decisionNote", async () => {
    const res = await PATCH(req({ qualityFlag: "MANUAL_REVIEW" }), { params: Promise.resolve({ id: "event_1" }) })

    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  // Clearing the flag (qualityFlag "" -> null) is a change, not a no-op, so it
  // is covered too — data.qualityFlag is null here, which is NOT undefined.
  it("refuses clearing the qualityFlag with no decisionNote", async () => {
    const res = await PATCH(req({ qualityFlag: "" }), { params: Promise.resolve({ id: "event_1" }) })

    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("accepts the Review pair when a reason is supplied", async () => {
    const res = await PATCH(req({ commissionStatus: "PENDING", qualityFlag: "MANUAL_REVIEW", decisionNote: "Awaiting proof of referral" }), { params: Promise.resolve({ id: "event_1" }) })

    expect(res.status).toBe(200)
    expect(eventUpdateMany.mock.calls[0][0].data).toMatchObject({
      commissionStatus: "PENDING",
      qualityFlag: "MANUAL_REVIEW",
      metadata: { lastDecision: expect.objectContaining({ note: "Awaiting proof of referral" }) },
    })
  })
})

// The note-only gap. Confirmed reachable on a live environment before it was
// closed: PATCH {decisionNote} alone returned 200, silently replaced the reason
// the queue displays for why an agent's money was withheld, and injected a
// REFERRAL_EVENT_DECIDED audit row for a decision nobody made.
describe("PATCH /api/agent-hub/referral-events/[id] — a note is not a decision", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authGuardMock.mockResolvedValue({ user: { id: "user_1", email: "ops@example.com", role: "LOAN_ADMIN" } })
    tenantContextMock.mockImplementation((_req, cb) => cb({ id: "tenant_acme" }))
    eventFindFirst.mockResolvedValue({
      ...existing,
      commissionStatus: "BLOCKED",
      qualityFlag: "LOW_QUALITY",
      metadata: { reference: "TF-123", lastDecision: { note: "Duplicate referral", byUserId: "user_9", byEmail: "prior@example.com", at: "2026-08-01T00:00:00.000Z", commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY" } },
    })
    eventUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("refuses a note-only PATCH, writing nothing and auditing nothing", async () => {
    const res = await PATCH(req({ decisionNote: "Actually it was fine" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    // The stored reason must survive untouched, and no decision may be recorded.
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses an empty body", async () => {
    const res = await PATCH(req({}), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses a note-only PATCH even when the note is long and plausible", async () => {
    // No length or content of note turns an annotation into a decision.
    const res = await PATCH(req({ decisionNote: "Reviewed with the agent by phone and confirmed the referral is genuine." }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("still allows a real decision, and records the note it replaced", async () => {
    const res = await PATCH(
      req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Checked — not a duplicate" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    // oldValue carries the PRIOR note, so the register shows what this decision
    // overwrote rather than only what it became.
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      action: "REFERRAL_EVENT_DECIDED",
      oldValue: { commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "Duplicate referral" },
      newValue: { commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Checked — not a duplicate" },
    })
  })

  // The guard must reject only when BOTH are absent. These two exist because
  // mutating `&&` to `||` — which would reject every single-field decision —
  // passed the whole suite without them.
  it("allows a commissionStatus-only decision when a note is supplied", async () => {
    const res = await PATCH(
      req({ commissionStatus: "PAYABLE", decisionNote: "Checked — not a duplicate" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(eventUpdateMany).toHaveBeenCalled()
    expect(eventUpdateMany.mock.calls[0][0].data.commissionStatus).toBe("PAYABLE")
    // qualityFlag was not supplied, so it must not be written at all.
    expect(eventUpdateMany.mock.calls[0][0].data).not.toHaveProperty("qualityFlag")
  })

  it("allows a qualityFlag-only decision when a note is supplied", async () => {
    const res = await PATCH(
      req({ qualityFlag: "MANUAL_REVIEW", decisionNote: "Awaiting proof of referral" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(eventUpdateMany.mock.calls[0][0].data.qualityFlag).toBe("MANUAL_REVIEW")
    expect(eventUpdateMany.mock.calls[0][0].data).not.toHaveProperty("commissionStatus")
  })

  it("allows clearing the qualityFlag when a note is supplied", async () => {
    // qualityFlag: "" becomes null — a supplied field, not an absent one.
    const res = await PATCH(
      req({ qualityFlag: "", decisionNote: "Flag no longer applies" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(eventUpdateMany.mock.calls[0][0].data.qualityFlag).toBeNull()
  })

  it("records a null prior note when the row had never been decided", async () => {
    eventFindFirst.mockResolvedValue({ ...existing, metadata: { reference: "TF-123" } })
    const res = await PATCH(
      req({ commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "Agent not eligible" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(logAuditMock.mock.calls[0][0].oldValue.decisionNote).toBeNull()
  })

  it("does not treat an array lastDecision as a prior note", async () => {
    eventFindFirst.mockResolvedValue({ ...existing, metadata: { lastDecision: [{ note: "smuggled" }] } })
    const res = await PATCH(
      req({ commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "Agent not eligible" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(logAuditMock.mock.calls[0][0].oldValue.decisionNote).toBeNull()
  })

  it("does not treat a malformed lastDecision as a prior note", async () => {
    eventFindFirst.mockResolvedValue({ ...existing, metadata: { lastDecision: "not-an-object" } })
    const res = await PATCH(
      req({ commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "Agent not eligible" }),
      { params: Promise.resolve({ id: "event_1" }) },
    )
    expect(res.status).toBe(200)
    expect(logAuditMock.mock.calls[0][0].oldValue.decisionNote).toBeNull()
  })
})

// A decision must CHANGE something. The first version of this guard only tested
// for PRESENCE, which closed `PATCH {decisionNote}` alone but left the same hole
// one step away: echo the row's current status back and the stored reason was
// still rewritten and an audit row still minted. Reproduced before fixing.
describe("PATCH /api/agent-hub/referral-events/[id] — a no-op is not a decision", () => {
  const decided = {
    id: "event_1",
    tenantId: "tenant_acme",
    commissionStatus: "BLOCKED",
    qualityFlag: "LOW_QUALITY",
    metadata: { lastDecision: { note: "Duplicate referral", byUserId: "user_9", at: "2026-08-01T00:00:00.000Z" } },
  }

  beforeEach(() => {
    vi.resetAllMocks()
    authGuardMock.mockResolvedValue({ user: { id: "user_1", email: "ops@example.com", role: "LOAN_ADMIN" } })
    tenantContextMock.mockImplementation((_req, cb) => cb({ id: "tenant_acme" }))
    eventFindFirst.mockResolvedValue(decided)
    eventUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("refuses a status echoing the current value, so the stored reason cannot be rewritten", async () => {
    const res = await PATCH(req({ commissionStatus: "BLOCKED", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses a flag echoing the current value", async () => {
    const res = await PATCH(req({ qualityFlag: "LOW_QUALITY", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses both fields echoing their current values", async () => {
    const res = await PATCH(req({ commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses a lowercase echo of the current value — normalisation must not create a difference", async () => {
    const res = await PATCH(req({ commissionStatus: "blocked", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses clearing a flag that is already null", async () => {
    eventFindFirst.mockResolvedValue({ ...decided, qualityFlag: null })
    const res = await PATCH(req({ qualityFlag: "", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("names the current state in the refusal so the caller is not left guessing", async () => {
    const res = await PATCH(req({ commissionStatus: "BLOCKED", decisionNote: "Rewritten" }), { params: Promise.resolve({ id: "event_1" }) })
    const body = await res.json()
    expect(body.error).toContain("BLOCKED")
    expect(body.error).toContain("LOW_QUALITY")
  })

  it("still accepts a real change on a decided row", async () => {
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "APPROVED", decisionNote: "Checked — not a duplicate" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(200)
    expect(eventUpdateMany).toHaveBeenCalled()
  })

  it("accepts a change to ONE field even when the other is echoed unchanged", async () => {
    // Only one of the two has to move for this to be a real decision.
    const res = await PATCH(req({ commissionStatus: "PAYABLE", qualityFlag: "LOW_QUALITY", decisionNote: "Releasing despite the flag" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(200)
  })
})

describe("PATCH /api/agent-hub/referral-events/[id] — malformed input", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authGuardMock.mockResolvedValue({ user: { id: "user_1", email: "ops@example.com", role: "LOAN_ADMIN" } })
    tenantContextMock.mockImplementation((_req, cb) => cb({ id: "tenant_acme" }))
    eventFindFirst.mockResolvedValue(existing)
    eventUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("rejects an array-valued commissionStatus rather than String()-coercing it", async () => {
    // String(["BLOCKED"]) === "BLOCKED", so an array reached the valid-value set
    // and was written as a decision.
    const res = await PATCH(req({ commissionStatus: ["BLOCKED"], decisionNote: "x" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects an array-valued qualityFlag", async () => {
    const res = await PATCH(req({ qualityFlag: ["LOW_QUALITY"], decisionNote: "x" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
    expect(eventUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects a numeric commissionStatus", async () => {
    const res = await PATCH(req({ commissionStatus: 1, decisionNote: "x" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
  })

  it("returns 400, not 500, for a null body", async () => {
    const res = await PATCH(req(null), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
  })

  it("returns 400 for an array body", async () => {
    const res = await PATCH(req([{ commissionStatus: "PAYABLE" }]), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(400)
  })

  it("still accepts an explicit null qualityFlag as a clear", async () => {
    eventFindFirst.mockResolvedValue({ ...existing, qualityFlag: "LOW_QUALITY" })
    const res = await PATCH(req({ qualityFlag: null, decisionNote: "Flag no longer applies" }), { params: Promise.resolve({ id: "event_1" }) })
    expect(res.status).toBe(200)
    expect(eventUpdateMany.mock.calls[0][0].data.qualityFlag).toBeNull()
  })

  it("records the CLEARED flag in metadata, not the flag it replaced", async () => {
    // `??` treated null as "not supplied", so the column went null while
    // metadata.lastDecision still claimed the old flag — the displayed decision
    // contradicted the row it described.
    eventFindFirst.mockResolvedValue({ ...existing, qualityFlag: "LOW_QUALITY" })
    await PATCH(req({ qualityFlag: "", decisionNote: "Flag no longer applies" }), { params: Promise.resolve({ id: "event_1" }) })
    const data = eventUpdateMany.mock.calls[0][0].data
    expect(data.qualityFlag).toBeNull()
    expect(data.metadata.lastDecision.qualityFlag).toBeNull()
  })
})
