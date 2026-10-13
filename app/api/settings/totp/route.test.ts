import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  findUser: vi.fn(),
  updateUser: vi.fn(),
  updateManyUser: vi.fn(),
  auditCreate: vi.fn(),
  required: vi.fn(),
  claim: vi.fn(),
  rate: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/totp-claim", () => ({ claimTotpCounter: (...a: unknown[]) => h.claim(...a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (...a: unknown[]) => h.required(...a) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => h.rate(...a), callerIp: () => "10.0.0.9" }))
vi.mock("@/lib/prisma", () => {
  const tx = { user: { update: (a: unknown) => h.updateUser(a), updateMany: (a: unknown) => h.updateManyUser(a) }, auditLog: { create: (a: unknown) => h.auditCreate(a) } }
  return { prisma: { ...tx, user: { ...tx.user, findFirst: (a: unknown) => h.findUser(a) }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { DELETE, POST } from "./route"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"

const secret = generateTotpSecret()
const staff = (extra: Record<string, unknown> = {}) => ({ user: { id: "u1", email: "officer@lender.example", name: "O", role: "CREDIT_OFFICER", tenantId: "t1", ...extra } })
const req = (method: string, body?: unknown) => new NextRequest("http://localhost/api/settings/totp", {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
})
const enrolledRow = { id: "u1", totpEnabled: true, totpSecret: secret }
const wrong = () => String((Number(generateTotpCode(secret)) + 7) % 1_000_000).padStart(6, "0")

beforeEach(() => {
  h.session = staff()
  h.findUser.mockReset().mockResolvedValue(enrolledRow)
  h.updateUser.mockReset().mockResolvedValue({})
  h.updateManyUser.mockReset().mockResolvedValue({ count: 1 })
  h.auditCreate.mockReset().mockResolvedValue({})
  h.required.mockReset().mockResolvedValue(false)
  h.claim.mockReset().mockResolvedValue(true)
  h.rate.mockReset().mockReturnValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 })
})

describe("DELETE /api/settings/totp — turning off your own 2FA", () => {
  it("refuses an anonymous caller and a CLIENT session", async () => {
    h.session = null
    expect((await DELETE(req("DELETE", { code: "123456" }))).status).toBe(401)
    h.session = { user: { id: "c1", email: "c@x.example", role: "CLIENT", tenantId: "t1" } }
    expect((await DELETE(req("DELETE", { code: "123456" }))).status).toBe(403)
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("refuses without a code, and clears nothing", async () => {
    for (const body of [undefined, {}, { code: "" }, { code: 123456 }, { code: ["123456"] }]) {
      const res = await DELETE(req("DELETE", body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it("refuses a wrong code with 422 and clears nothing", async () => {
    const res = await DELETE(req("DELETE", { code: wrong() }))
    expect(res.status).toBe(422)
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it("refuses a replayed code (the counter was already used) with 422", async () => {
    h.claim.mockResolvedValue(false)
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(422)
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("claims the matched counter for the caller's own row", async () => {
    await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(h.claim).toHaveBeenCalledWith("u1", expect.any(Number))
  })

  it("clears the secret and writes the audit row in the same transaction when the code is valid", async () => {
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.updateUser).toHaveBeenCalledWith({ where: { id: "u1" }, data: { totpSecret: null, totpEnabled: false } })
    expect(h.auditCreate).toHaveBeenCalledTimes(1)
    expect(h.auditCreate.mock.calls[0]![0].data).toMatchObject({
      tenantId: "t1", userId: "u1", userEmail: "officer@lender.example", action: "TOTP_DISABLED",
      entity: "User", entityId: "u1", oldValue: { totpEnabled: true }, newValue: { totpEnabled: false }, ipAddress: "10.0.0.9",
    })
  })

  it("never records the secret or the code", async () => {
    const code = generateTotpCode(secret)
    await DELETE(req("DELETE", { code }))
    const written = JSON.stringify(h.auditCreate.mock.calls)
    expect(written).not.toContain(secret)
    expect(written).not.toContain(code)
  })

  it("refuses outright while the lender requires 2FA, even with a valid code", async () => {
    h.required.mockResolvedValue(true)
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(403)
    expect(h.required).toHaveBeenCalledWith("t1")
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("answers 429 once the caller has guessed too often, before it looks at the code", async () => {
    h.rate.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 })
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(429)
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.updateUser).not.toHaveBeenCalled()
  })

  it("does nothing, and writes no audit row, for a caller with no 2FA to turn off", async () => {
    h.findUser.mockResolvedValue({ id: "u1", totpEnabled: false, totpSecret: null })
    const res = await DELETE(req("DELETE", { code: "123456" }))
    expect(res.status).toBe(200)
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it("looks the caller up in the session's tenant", async () => {
    await DELETE(req("DELETE", { code: wrong() }))
    expect(h.findUser).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1", tenantId: "t1" } }))
  })
})

describe("POST /api/settings/totp — enrolling", () => {
  const body = () => ({ secret, code: generateTotpCode(secret) })

  beforeEach(() => { h.findUser.mockResolvedValue({ id: "u1", totpEnabled: false, totpSecret: null }) })

  it("enrols, audits, and leaves the session alone when the lender did not force it", async () => {
    const res = await POST(req("POST", body()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, signInAgain: false })
    expect(h.updateManyUser).toHaveBeenCalledWith({
      where: { id: "u1", tenantId: "t1", totpEnabled: false, totpSecret: null },
      data: { totpSecret: secret, totpEnabled: true },
    })
    expect(h.auditCreate.mock.calls[0]![0].data).toMatchObject({
      action: "TOTP_ENROLLED", userId: "u1", entityId: "u1", oldValue: { totpEnabled: false }, newValue: { totpEnabled: true },
    })
    expect(JSON.stringify(h.auditCreate.mock.calls)).not.toContain(secret)
  })

  it("ends a forced session on enrolment, so the next sign-in carries a code", async () => {
    h.session = staff({ totpEnrolmentRequired: true })
    const res = await POST(req("POST", body()))
    expect(await res.json()).toEqual({ ok: true, signInAgain: true })
    expect(h.updateManyUser).toHaveBeenCalledWith({
      where: { id: "u1", tenantId: "t1", totpEnabled: false, totpSecret: null },
      data: { totpSecret: secret, totpEnabled: true, tokenVersion: { increment: 1 } },
    })
  })

  it("refuses a wrong code with 422", async () => {
    const res = await POST(req("POST", { secret, code: wrong() }))
    expect(res.status).toBe(422)
    expect(h.updateManyUser).not.toHaveBeenCalled()
  })

  // Replacing the secret of an enrolled account would undo the code check on
  // turning 2FA off: whoever holds the session could swap in their own.
  it("refuses with 409 to replace the secret of an account that is already enrolled", async () => {
    h.updateManyUser.mockResolvedValue({ count: 0 })
    const res = await POST(req("POST", body()))
    expect(res.status).toBe(409)
    expect(h.auditCreate).not.toHaveBeenCalled()
  })
})
