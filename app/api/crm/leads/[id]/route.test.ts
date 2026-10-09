/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const leadFindFirstMock = vi.fn()
const leadUpdateMock = vi.fn()
const userFindFirstMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findFirst: (a: unknown) => leadFindFirstMock(a), update: (a: unknown) => leadUpdateMock(a) },
    user: { findFirst: (a: unknown) => userFindFirstMock(a) },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { PATCH } from "./route"

const ctx = { params: Promise.resolve({ id: "lead-1" }) }
function req(body: unknown) {
  return new NextRequest("http://x/api/crm/leads/lead-1", { method: "PATCH", body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "CREDIT_OFFICER" } })
  withTenantContextMock.mockImplementation((_r: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    cb({ id: "t1" }))
  leadFindFirstMock.mockResolvedValue({ status: "NEW", assignedToId: null, requestedAmount: null, declaredIncome: null })
  leadUpdateMock.mockResolvedValue({ id: "lead-1", status: "NEW", assignedToId: "u2", requestedAmount: null, declaredIncome: null })
})

// requestedAmount stopped being a mere scoring input when lead outreach began
// gating on it (lib/crm/lead-outreach-eligibility.ts): it is now the recorded
// fact that says "this person asked us for credit", i.e. the lawful basis for
// sending them an unsolicited-looking credit message. Whoever sets it creates
// that basis, so the audit trail has to show who, when, and from what — a
// regulator asking "on what basis did you message this person?" cannot be
// answered by reading the lead's current value.
describe("PATCH /api/crm/leads/[id] — audits the fields the outreach basis rests on", () => {
  it("records the old and new requestedAmount", async () => {
    leadFindFirstMock.mockResolvedValue({ status: "NEW", assignedToId: null, requestedAmount: null, declaredIncome: null })
    leadUpdateMock.mockResolvedValue({ id: "lead-1", status: "NEW", assignedToId: null, requestedAmount: 500_000, declaredIncome: null })

    await PATCH(req({ requestedAmount: 500_000 }), ctx as any)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LEAD_UPDATED",
        entity: "Lead",
        entityId: "lead-1",
        oldValue: expect.objectContaining({ requestedAmount: null }),
        newValue: expect.objectContaining({ requestedAmount: 500_000 }),
      })
    )
  })

  it("records declaredIncome too — same NCA affordability shape", async () => {
    leadFindFirstMock.mockResolvedValue({ status: "NEW", assignedToId: null, requestedAmount: 1, declaredIncome: 100 })
    leadUpdateMock.mockResolvedValue({ id: "lead-1", status: "NEW", assignedToId: null, requestedAmount: 1, declaredIncome: 900 })

    await PATCH(req({ declaredIncome: 900 }), ctx as any)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        oldValue: expect.objectContaining({ declaredIncome: 100 }),
        newValue: expect.objectContaining({ declaredIncome: 900 }),
      })
    )
  })

  it("reads the audited fields from the DB — an unselected field audits as undefined", async () => {
    await PATCH(req({ notes: "x" }), ctx as any)

    expect(leadFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ requestedAmount: true, declaredIncome: true }),
      })
    )
  })
})

// This route shares the CREDIT_OFFICER gate with the reassign server action.
// Before the validation existed, anyone who could use the picker could instead
// PATCH an arbitrary assignedToId here and bypass it entirely.
describe("PATCH /api/crm/leads/[id] — assignee validation", () => {
  it("rejects an assignee that is not active staff of this tenant, and does not write", async () => {
    userFindFirstMock.mockResolvedValue(null)

    const res = await PATCH(req({ assignedToId: "other-tenant-user" }), ctx as any)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: "That staff member can no longer be assigned leads",
    })
    expect(leadUpdateMock).not.toHaveBeenCalled()
  })

  it("validates the assignee scoped to tenant + active", async () => {
    userFindFirstMock.mockResolvedValue({ id: "u2" })

    await PATCH(req({ assignedToId: "u2" }), ctx as any)

    expect(userFindFirstMock).toHaveBeenCalledWith({
      where: { id: "u2", tenantId: "t1", active: true },
      select: { id: true },
    })
  })

  it("accepts a valid assignee and writes it", async () => {
    userFindFirstMock.mockResolvedValue({ id: "u2" })

    const res = await PATCH(req({ assignedToId: "u2" }), ctx as any)

    expect(res.status).toBe(200)
    expect(leadUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: "u2" }) })
    )
  })

  it("skips the assignee lookup entirely for updates that do not touch the owner", async () => {
    await PATCH(req({ notes: "just a note" }), ctx as any)

    expect(userFindFirstMock).not.toHaveBeenCalled()
    expect(leadUpdateMock).toHaveBeenCalled()
  })

  it("normalises an empty-string assignedToId to null rather than storing \"\"", async () => {
    // "" is falsy so it skips validation and means "unassign" — but stored raw
    // it reads as assigned to the `assignedToId: { not: null }` filters in the
    // stale-leads-alert cron and the advisor report, while the UI renders it
    // Unassigned. POST already normalises; PATCH now matches.
    const res = await PATCH(req({ assignedToId: "" }), ctx as any)

    expect(res.status).toBe(200)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    expect(leadUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: null }) })
    )
  })

  it("treats an explicit null assignedToId as an unassign, not an invalid assignee", async () => {
    const res = await PATCH(req({ assignedToId: null }), ctx as any)

    expect(res.status).toBe(200)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    expect(leadUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: null }) })
    )
  })
})
