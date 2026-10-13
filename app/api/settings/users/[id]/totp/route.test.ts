import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  findTarget: vi.fn(),
  locked: vi.fn(),
  updateUser: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "10.0.0.9" }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: (...a: unknown[]) => h.locked(...a),
    user: { update: (a: unknown) => h.updateUser(a) },
    auditLog: { create: (a: unknown) => h.auditCreate(a) },
  }
  return { prisma: { ...tx, user: { ...tx.user, findFirst: (a: unknown) => h.findTarget(a) }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { DELETE } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "admin-1", email: "admin@lender.example", name: "A", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const call = (id = "target-1") => DELETE(
  new NextRequest(`http://localhost/api/settings/users/${id}/totp`, { method: "DELETE" }),
  { params: Promise.resolve({ id }) },
)
const row = (id: string, role: string, tokenVersion = 2) => ({ id, role, active: true, tokenVersion })

beforeEach(() => {
  h.session = caller("ADMIN")
  h.findTarget.mockReset().mockResolvedValue({ role: "CREDIT_OFFICER", totpEnabled: true })
  h.locked.mockReset().mockResolvedValue([row("admin-1", "ADMIN"), row("target-1", "CREDIT_OFFICER")])
  h.updateUser.mockReset().mockResolvedValue({})
  h.auditCreate.mockReset().mockResolvedValue({})
})

describe("DELETE /api/settings/users/[id]/totp — an admin resets another user's 2FA", () => {
  it("clears the secret, signs the target out, and audits who did it, in one transaction", async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.updateUser).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { totpSecret: null, totpEnabled: false, lastTotpCounter: null, tokenVersion: { increment: 1 } },
      select: { id: true },
    })
    expect(h.auditCreate).toHaveBeenCalledTimes(1)
    expect(h.auditCreate.mock.calls[0]![0].data).toMatchObject({
      tenantId: "t1", userId: "admin-1", userEmail: "admin@lender.example", action: "TOTP_RESET_BY_ADMIN",
      entity: "User", entityId: "target-1", oldValue: { totpEnabled: true }, newValue: { totpEnabled: false }, ipAddress: "10.0.0.9",
    })
  })

  it("is for ADMIN and above only", async () => {
    for (const role of ["READONLY", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER"]) {
      h.session = caller(role)
      expect((await call()).status, role).toBe(403)
    }
    h.session = null
    expect((await call()).status).toBe(401)
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("needs a TOTP-verified session", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await call()
    expect(res.status).toBe(403)
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("will not reset the caller's own 2FA: that needs their current code (DELETE /api/settings/totp)", async () => {
    const res = await call("admin-1")
    expect(res.status).toBe(400)
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("must outrank the target: a peer or a senior is refused, and audited as a refusal", async () => {
    for (const targetRole of ["ADMIN", "SUPER_ADMIN"]) {
      h.findTarget.mockResolvedValue({ role: targetRole, totpEnabled: true })
      const res = await call()
      expect(res.status, targetRole).toBe(403)
    }
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(h.auditCreate.mock.calls.map((c) => c[0].data.action)).toEqual(["USER_WRITE_REFUSED", "USER_WRITE_REFUSED"])
  })

  it("a SUPER_ADMIN resets an ADMIN but not another SUPER_ADMIN", async () => {
    h.session = caller("SUPER_ADMIN")
    h.findTarget.mockResolvedValue({ role: "ADMIN", totpEnabled: true })
    h.locked.mockResolvedValue([row("admin-1", "SUPER_ADMIN"), row("target-1", "ADMIN")])
    expect((await call()).status).toBe(200)
    h.findTarget.mockResolvedValue({ role: "SUPER_ADMIN", totpEnabled: true })
    expect((await call()).status).toBe(403)
  })

  it("answers 404 for a user in another tenant", async () => {
    h.findTarget.mockResolvedValue(null)
    expect((await call()).status).toBe(404)
    expect(h.findTarget).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "target-1", tenantId: "t1" } }))
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("re-checks on the locked rows: a target promoted to the caller's rank since the first read is refused", async () => {
    h.locked.mockResolvedValue([row("admin-1", "ADMIN"), row("target-1", "ADMIN")])
    const res = await call()
    expect(res.status).toBe(403)
    expect(h.updateUser).not.toHaveBeenCalled()
  })
})
