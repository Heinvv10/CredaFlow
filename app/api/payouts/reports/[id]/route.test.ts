import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ requireApiRole: vi.fn(), totpRequired: vi.fn(), ack: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => h.requireApiRole(...a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (...a: unknown[]) => h.totpRequired(...a) }))
vi.mock("@/lib/payouts/unapplied-reports", () => ({ acknowledgeUnappliedReport: (...a: unknown[]) => h.ack(...a) }))

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/payouts/reports/ur-1", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "ur-1" }) })
const staff = (totpVerified: boolean) => ({ error: null, user: { id: "u-1", email: "u1@test.invalid", role: "LOAN_ADMIN", totpVerified } })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue(staff(true))
  h.totpRequired.mockResolvedValue(true)
  h.ack.mockResolvedValue({ ok: true })
})

describe("POST /api/payouts/reports/[id]", () => {
  it("requires LOAN_ADMIN", async () => {
    h.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }), user: null })
    expect((await post({ note: "Checked with the provider" })).status).toBe(403)
    expect(h.requireApiRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(h.ack).not.toHaveBeenCalled()
  })

  it("refuses a session without two-factor authentication when the lender requires it", async () => {
    h.requireApiRole.mockResolvedValue(staff(false))
    expect((await post({ note: "Checked with the provider" })).status).toBe(403)
    expect(h.ack).not.toHaveBeenCalled()
  })

  it("needs a note, and acknowledges within the caller's tenant as the signed-in user", async () => {
    expect((await post({ note: "ok" })).status).toBe(400)
    expect((await post({ note: "Checked with the provider" })).status).toBe(200)
    expect(h.ack).toHaveBeenCalledWith(expect.anything(), { tenantId: "t-1", id: "ur-1", note: "Checked with the provider", actor: { id: "u-1", email: "u1@test.invalid" } })
  })
})
