import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const updateMock = vi.fn()
const updateManyMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: {
      findUnique: (a: unknown) => findUniqueMock(a),
      update: (a: unknown) => updateMock(a),
      updateMany: (a: unknown) => updateManyMock(a),
    },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: { LOAN_STATUS_CHANGED: "LOAN_STATUS_CHANGED" },
}))

import { PATCH } from "./route"

const ctx = { params: Promise.resolve({ id: "loan-1" }) }
function patchReq(body: unknown) {
  return new NextRequest("http://x/api/loans/loan-1/write-off", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

const requestedAt = new Date("2026-06-01T00:00:00Z")

const pendingLoan = {
  id: "loan-1",
  status: "PENDING_WRITE_OFF",
  outstandingPrincipal: 50000,
  reference: "L-001",
  writeOffRequestedById: "requester-1",
  writeOffReason: "Untraceable client",
  writeOffRequestedAt: requestedAt,
  daysInArrears: 120,
}

const activeLoan = {
  id: "loan-1",
  status: "ACTIVE",
  outstandingPrincipal: 50000,
  reference: "L-001",
  writeOffRequestedById: null,
  writeOffReason: null,
  writeOffRequestedAt: null,
  daysInArrears: 30,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "approver-1", email: "approver@x.co", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
  updateManyMock.mockResolvedValue({ count: 1 })
})

it("requests a write-off on a non-terminal loan", async () => {
  findUniqueMock.mockResolvedValue(activeLoan)

  const res = await PATCH(patchReq({ action: "request", reason: "Untraceable client" }), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "loan-1", status: "PENDING_WRITE_OFF" })
  expect(updateManyMock).toHaveBeenCalledWith({
    where: { id: "loan-1", tenantId: "t1", status: { notIn: ["WRITTEN_OFF", "PENDING_WRITE_OFF"] } },
    data: expect.objectContaining({ status: "PENDING_WRITE_OFF", writeOffReason: "Untraceable client", writeOffRequestedById: "approver-1" }),
  })
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({ newValue: expect.objectContaining({ step: "requested" }) })
  )
})

it("requires a reason to request a write-off", async () => {
  findUniqueMock.mockResolvedValue(activeLoan)

  const res = await PATCH(patchReq({ action: "request" }), ctx)

  expect(res.status).toBe(422)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("blocks a request when the loan is already WRITTEN_OFF or PENDING_WRITE_OFF (pre-check)", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "request", reason: "Untraceable client" }), ctx)

  expect(res.status).toBe(409)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("409s the request when a concurrent write already moved the loan into a terminal write-off state (race guard)", async () => {
  findUniqueMock.mockResolvedValue(activeLoan)
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await PATCH(patchReq({ action: "request", reason: "Untraceable client" }), ctx)

  expect(res.status).toBe(409)
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("approves a pending write-off when the approver differs from the requester", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(200)
  expect(updateManyMock).toHaveBeenCalledWith({
    where: { id: "loan-1", tenantId: "t1", status: "PENDING_WRITE_OFF", writeOffRequestedAt: requestedAt },
    data: expect.objectContaining({ status: "WRITTEN_OFF", writeOffApprovedById: "approver-1" }),
  })
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({ newValue: expect.objectContaining({ step: "approved" }) })
  )
})

it("blocks approval when the approver is also the requester (maker-checker)", async () => {
  requireApiRoleMock.mockResolvedValue({ user: { id: "requester-1", email: "requester@x.co", role: "LOAN_ADMIN" } })
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(422)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("blocks approval when the loan is not pending write-off", async () => {
  findUniqueMock.mockResolvedValue({ ...pendingLoan, status: "ACTIVE" })

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(409)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("409s and skips the audit log when a concurrent action already moved the loan off PENDING_WRITE_OFF (approve)", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(409)
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("rejects a pending write-off and reverts status to DEFAULTED when 90+ DPD", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "reject", reason: "Insufficient grounds" }), ctx)

  expect(res.status).toBe(200)
  expect(updateManyMock).toHaveBeenCalledWith({
    where: { id: "loan-1", tenantId: "t1", status: "PENDING_WRITE_OFF", writeOffRequestedAt: requestedAt },
    data: {
      status: "DEFAULTED",
      writeOffReason: null,
      writeOffRequestedById: null,
      writeOffRequestedAt: null,
    },
  })
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({ newValue: expect.objectContaining({ step: "rejected" }) })
  )
})

it("reverts status to ACTIVE on reject when under 90 DPD", async () => {
  findUniqueMock.mockResolvedValue({ ...pendingLoan, daysInArrears: 45 })

  await PATCH(patchReq({ action: "reject", reason: "Insufficient grounds" }), ctx)

  expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE" }) }))
})

it("requires a reason to reject", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "reject" }), ctx)

  expect(res.status).toBe(422)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("blocks rejection when the approver is also the requester (maker-checker)", async () => {
  requireApiRoleMock.mockResolvedValue({ user: { id: "requester-1", email: "requester@x.co", role: "LOAN_ADMIN" } })
  findUniqueMock.mockResolvedValue(pendingLoan)

  const res = await PATCH(patchReq({ action: "reject", reason: "Insufficient grounds" }), ctx)

  expect(res.status).toBe(422)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("blocks rejection when the loan is not pending write-off", async () => {
  findUniqueMock.mockResolvedValue({ ...pendingLoan, status: "ACTIVE" })

  const res = await PATCH(patchReq({ action: "reject", reason: "Insufficient grounds" }), ctx)

  expect(res.status).toBe(409)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("409s and skips the audit log when a concurrent action already moved the loan off PENDING_WRITE_OFF (reject)", async () => {
  findUniqueMock.mockResolvedValue(pendingLoan)
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await PATCH(patchReq({ action: "reject", reason: "Insufficient grounds" }), ctx)

  expect(res.status).toBe(409)
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("409s approve when the loan moved to a different write-off episode (reject-then-request race, episode pin)", async () => {
  // Loan status is PENDING_WRITE_OFF (passes the status pin) but the
  // requestedAt timestamp the approver read is stale — a reject followed by
  // a fresh request happened in between. The episode pin must still refuse.
  findUniqueMock.mockResolvedValue(pendingLoan)
  updateManyMock.mockResolvedValue({ count: 0 }) // where clause wouldn't match the new episode's writeOffRequestedAt

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(409)
  expect(updateManyMock).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ writeOffRequestedAt: requestedAt }) })
  )
})

it("404s when the loan does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)
  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)
  expect(res.status).toBe(404)
})

it("short-circuits with the guard's response when unauthorized", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

  const res = await PATCH(patchReq({ action: "approve", confirm: true }), ctx)

  expect(res.status).toBe(403)
  expect(findUniqueMock).not.toHaveBeenCalled()
})
