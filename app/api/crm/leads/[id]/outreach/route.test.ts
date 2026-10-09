/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const sendLeadOutreachMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/crm/lead-outreach", () => ({ sendLeadOutreach: (a: unknown) => sendLeadOutreachMock(a) }))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "lead-1" }) }
const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
function req(body: Record<string, unknown>) {
  return new NextRequest("http://x/api/crm/leads/lead-1/outreach", {
    method: "POST",
    body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", name: "Thabo Molefe", role: "CREDIT_OFFICER" } })
  withTenantContextMock.mockImplementation((_r: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }))
  sendLeadOutreachMock.mockResolvedValue({
    ok: true,
    messageId: "m1",
    conversationId: "c1",
    status: "SENT",
    outcome: "sent",
  })
})

describe("POST /api/crm/leads/[id]/outreach", () => {
  it("sends the requested outreach, tenant-scoped, signed by the agent", async () => {
    const res = await POST(req({ kind: "QUALIFICATION", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      messageId: "m1",
      conversationId: "c1",
      sent: true,
      simulated: false,
      pending: false,
      reconciliationRequired: false,
    })
    expect(sendLeadOutreachMock).toHaveBeenCalledWith({
      tenantId: "t1",
      leadId: "lead-1",
      kind: "QUALIFICATION",
      channel: "WHATSAPP",
      agentUserId: "u1",
      agentFullName: "Thabo Molefe",
      operationId: OPERATION_ID,
    })
  })

  it("keeps the READONLY floor of its free-text sibling", () => {
    // Decision 1 of #334, reaffirmed by Hein — any staff who can view the
    // record may message it. Tightening this needs a product decision.
    return POST(req({ kind: "QUALIFICATION", channel: "WHATSAPP" }), ctx as any).then(() => {
      expect(requireApiRoleMock).toHaveBeenCalledWith("READONLY")
    })
  })

  it("audits the outreach against the Lead on success", async () => {
    await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        action: "LEAD_OUTREACH_SENT",
        entity: "Lead",
        entityId: "lead-1",
        newValue: {
          kind: "REENGAGE",
          channel: "WHATSAPP",
          messageId: "m1",
          messageStatus: "SENT",
          outcome: "sent",
          sent: true,
          simulated: false,
          pending: false,
          reconciliationRequired: false,
        },
      })
    )
  })

  it("audits and returns a dry-run as simulated, never sent", async () => {
    sendLeadOutreachMock.mockResolvedValue({
      ok: true,
      messageId: "m-sim",
      conversationId: "c1",
      status: "SIMULATED",
      outcome: "simulated",
    })

    const res = await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    await expect(res.json()).resolves.toMatchObject({ simulated: true })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "LEAD_OUTREACH_SIMULATED",
      newValue: expect.objectContaining({ simulated: true }),
    }))
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LEAD_OUTREACH_SENT" }))
  })

  it("rejects an unknown kind before sending anything", async () => {
    const res = await POST(req({ kind: "FREE_TEXT_PITCH", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(400)
    expect(sendLeadOutreachMock).not.toHaveBeenCalled()
  })

  it("rejects a missing operation id before sending anything", async () => {
    const res = await POST(req({ kind: "QUALIFICATION", channel: "WHATSAPP", operationId: undefined }), ctx as any)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "operationId is required" })
    expect(sendLeadOutreachMock).not.toHaveBeenCalled()
  })

  it("audits an ambiguous outcome as reconciliation-required, never sent", async () => {
    sendLeadOutreachMock.mockResolvedValue({
      ok: true,
      messageId: "m-ambiguous",
      conversationId: "c1",
      status: "RECONCILIATION_REQUIRED",
      outcome: "reconciliation_required",
    })

    const res = await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    await expect(res.json()).resolves.toMatchObject({ reconciliationRequired: true, simulated: false })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "LEAD_OUTREACH_RECONCILIATION_REQUIRED",
      newValue: expect.objectContaining({ reconciliationRequired: true }),
    }))
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LEAD_OUTREACH_SENT" }))
  })

  it("returns 202 and audits pending for an idempotent retry replay", async () => {
    sendLeadOutreachMock.mockResolvedValue({
      ok: true,
      messageId: "m-retrying",
      conversationId: "c1",
      status: "RETRYING",
      outcome: "pending",
    })

    const res = await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toMatchObject({ sent: false, pending: true })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "LEAD_OUTREACH_PENDING",
      newValue: expect.objectContaining({ outcome: "pending", sent: false }),
    }))
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LEAD_OUTREACH_SENT" }))
  })

  it("returns 409 and audits not-sent for a terminal failed replay", async () => {
    sendLeadOutreachMock.mockResolvedValue({
      ok: true,
      messageId: "m-failed",
      conversationId: "c1",
      status: "FAILED_PERMANENT",
      outcome: "not_sent",
    })

    const res = await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      reason: "SEND_FAILED",
      messageId: "m-failed",
      terminal: true,
    })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "LEAD_OUTREACH_NOT_SENT",
      newValue: expect.objectContaining({ outcome: "not_sent", sent: false }),
    }))
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LEAD_OUTREACH_SENT" }))
  })

  it("rejects a prototype-chain kind before sending anything", async () => {
    const res = await POST(req({ kind: "constructor", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(400)
    expect(sendLeadOutreachMock).not.toHaveBeenCalled()
  })

  it("rejects SMS — its reply and STOP would be silently dropped", async () => {
    // SMS is send-only in this system (no inbound webhook). Every outreach body
    // asks the lead to reply, so a hand-crafted SMS request must be refused at
    // the boundary, not just hidden in the UI.
    const res = await POST(req({ kind: "QUALIFICATION", channel: "SMS" }), ctx as any)

    expect(res.status).toBe(400)
    expect(sendLeadOutreachMock).not.toHaveBeenCalled()
  })

  it("rejects EMAIL — outreach is WhatsApp only", async () => {
    const res = await POST(req({ kind: "QUALIFICATION", channel: "EMAIL" }), ctx as any)

    expect(res.status).toBe(400)
    expect(sendLeadOutreachMock).not.toHaveBeenCalled()
  })

  it("surfaces a consent/eligibility block as 409 and never claims an outreach was sent", async () => {
    sendLeadOutreachMock.mockResolvedValue({ ok: false, reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })

    const res = await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })
    expect(logAuditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAD_OUTREACH_SENT" })
    )
  })

  it("audits a BLOCKED attempt — a regulator asks who tried to contact an opted-out person", async () => {
    sendLeadOutreachMock.mockResolvedValue({ ok: false, reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })

    await POST(req({ kind: "REENGAGE", channel: "WHATSAPP" }), ctx as any)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LEAD_OUTREACH_BLOCKED",
        entity: "Lead",
        entityId: "lead-1",
        userId: "u1",
        newValue: expect.objectContaining({ reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" }),
      })
    )
  })

  it.each([
    ["NOT_A_LOAN_ENQUIRY", 409],
    ["LEAD_CLOSED", 409],
    ["NO_DESTINATION", 409],
    // Structural, not a contactability decision — mirrors messages/route.ts.
    ["NO_CONTACT", 400],
  ])("maps %s to HTTP %i", async (reason, status) => {
    sendLeadOutreachMock.mockResolvedValue({ ok: false, reason, detail: "d" })

    const res = await POST(req({ kind: "QUALIFICATION", channel: "WHATSAPP" }), ctx as any)

    expect(res.status).toBe(status)
    expect(logAuditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAD_OUTREACH_SENT" })
    )
  })
})
