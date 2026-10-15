import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  totpRequired: vi.fn(),
  caseFindFirst: vi.fn(),
  reversalFindFirst: vi.fn(),
  escalate: vi.fn(),
  record: vi.fn(),
  close: vi.fn(),
  ack: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payoutRecoveryCase: { findFirst: (...a: unknown[]) => h.caseFindFirst(...a) },
    disbursementReversal: { findFirst: (...a: unknown[]) => h.reversalFindFirst(...a) },
  },
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => h.requireApiRole(...a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (...a: unknown[]) => h.totpRequired(...a) }))
vi.mock("@/lib/payouts/recovery", () => ({
  escalateRecovery: (...a: unknown[]) => h.escalate(...a),
  recordRecoveredFunds: (...a: unknown[]) => h.record(...a),
  closeRecoveryUnrecoverable: (...a: unknown[]) => h.close(...a),
}))
vi.mock("@/lib/payouts/reversal", () => ({
  acknowledgeDebitOrderCancelled: (...a: unknown[]) => h.ack(...a),
  decideDisbursementReversal: vi.fn(),
  requestDisbursementReversal: vi.fn(),
}))

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/loans/loan-1/payout", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "loan-1" }) })
const staff = (totpVerified: boolean) => ({ error: null, user: { id: "u-1", email: "u1@test.invalid", role: "LOAN_ADMIN", totpVerified } })
const actions = [
  { action: "escalate_recovery", caseId: "rc-1", note: "Recipient will not return it" },
  { action: "close_unrecoverable", caseId: "rc-1", note: "Recipient account closed" },
  { action: "record_recovery", caseId: "rc-1", note: "Recalled by the bank", recoveredAt: "2026-10-01", amountCents: 200_000 },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue(staff(true))
  h.totpRequired.mockResolvedValue(true)
  h.caseFindFirst.mockResolvedValue({ id: "rc-1" })
  for (const fn of [h.escalate, h.record, h.close]) fn.mockResolvedValue({ ok: true, status: "OPEN" })
})

describe("POST /api/loans/[id]/payout — recovery actions", () => {
  it("requires LOAN_ADMIN", async () => {
    h.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }), user: null })
    for (const body of actions) expect((await post(body)).status).toBe(403)
    expect(h.requireApiRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(h.escalate).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it("refuses a session without two-factor authentication when the lender requires it", async () => {
    h.requireApiRole.mockResolvedValue(staff(false))
    for (const body of actions) expect((await post(body)).status).toBe(403)
    expect(h.escalate).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it("acts only on a case of this loan in the caller's tenant", async () => {
    h.caseFindFirst.mockResolvedValue(null)
    for (const body of actions) expect((await post(body)).status).toBe(404)
    expect(h.caseFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rc-1", tenantId: "t-1", loanId: "loan-1" } }))
    expect(h.escalate).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it("passes the signed-in user, the tenant and the entered amount through", async () => {
    for (const body of actions) expect((await post(body)).status).toBe(200)
    const actor = { id: "u-1", email: "u1@test.invalid" }
    expect(h.escalate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "t-1", caseId: "rc-1", actor }))
    expect(h.close).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "t-1", caseId: "rc-1", actor }))
    expect(h.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "t-1", caseId: "rc-1", amountCents: 200_000, actor }))
  })
})
