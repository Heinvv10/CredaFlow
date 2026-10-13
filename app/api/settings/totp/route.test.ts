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
const auditActions = () => h.auditCreate.mock.calls.map((c) => c[0].data.action)
const refusalRow = () => h.auditCreate.mock.calls.map((c) => c[0].data).find((d) => d.action === "TOTP_CHANGE_REFUSED")
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

  it("refuses a wrong code with 422, clears nothing, and audits the failed attempt", async () => {
    const res = await DELETE(req("DELETE", { code: wrong() }))
    expect(res.status).toBe(422)
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(auditActions()).toEqual(["TOTP_CHANGE_REFUSED"])
    expect(refusalRow()).toMatchObject({
      tenantId: "t1", userId: "u1", userEmail: "officer@lender.example", entity: "User", entityId: "u1",
      newValue: { refused: true, reason: "wrong_code", httpStatus: 422, operation: "disable" },
    })
    expect(JSON.stringify(h.auditCreate.mock.calls)).not.toContain(secret)
  })

  it("refuses a replayed code (the counter was already used) with 422, and audits it as a replay", async () => {
    h.claim.mockResolvedValue(false)
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(422)
    expect(h.updateUser).not.toHaveBeenCalled()
    expect(refusalRow()).toMatchObject({ newValue: { reason: "replayed_code", operation: "disable" } })
  })

  it("claims the matched counter for the caller's own row", async () => {
    await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(h.claim).toHaveBeenCalledWith("u1", expect.any(Number))
  })

  it("clears the secret and writes the audit row in the same transaction when the code is valid", async () => {
    const res = await DELETE(req("DELETE", { code: generateTotpCode(secret) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // Sessions signed in with a code must not outlive the 2FA that vouched for them.
    expect(h.updateUser).toHaveBeenCalledWith({ where: { id: "u1" }, data: { totpSecret: null, totpEnabled: false, tokenVersion: { increment: 1 } } })
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
    expect(auditActions()).toEqual(["TOTP_CHANGE_REFUSED"])
    expect(refusalRow()).toMatchObject({ entityId: "u1", newValue: { refused: true, reason: "policy_requires_totp", httpStatus: 403, operation: "disable" } })
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
      data: { totpSecret: secret, totpEnabled: true, lastTotpCounter: null },
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
      data: { totpSecret: secret, totpEnabled: true, lastTotpCounter: null, tokenVersion: { increment: 1 } },
    })
  })

  it("refuses a wrong code with 422", async () => {
    const res = await POST(req("POST", { secret, code: wrong() }))
    expect(res.status).toBe(422)
    expect(h.updateManyUser).not.toHaveBeenCalled()
  })

  // Replacing the secret of an enrolled account would undo the code check on
  // turning 2FA off: whoever holds the session could swap in their own.
  describe("when the account is already enrolled (replacing the secret)", () => {
    const old = generateTotpSecret()
    const replace = (extra: Record<string, unknown> = {}) => POST(req("POST", { ...body(), ...extra }))
    beforeEach(() => { h.findUser.mockResolvedValue({ id: "u1", totpEnabled: true, totpSecret: old }) })

    it("refuses with 409 without the current code, and replaces nothing", async () => {
      const res = await replace()
      expect(res.status).toBe(409)
      expect(h.updateManyUser).not.toHaveBeenCalled()
      expect(h.auditCreate).not.toHaveBeenCalled()
    })

    it("refuses a wrong or replayed current code with 422, replaces nothing, and audits each attempt", async () => {
      expect((await replace({ currentCode: "000000" })).status).toBe(422)
      h.claim.mockResolvedValue(false)
      expect((await replace({ currentCode: generateTotpCode(old) })).status).toBe(422)
      expect(h.updateManyUser).not.toHaveBeenCalled()
      expect(h.auditCreate.mock.calls.map((c) => c[0].data.newValue)).toEqual([
        { refused: true, reason: "wrong_code", httpStatus: 422, operation: "replace" },
        { refused: true, reason: "replayed_code", httpStatus: 422, operation: "replace" },
      ])
      const written = JSON.stringify(h.auditCreate.mock.calls)
      expect(written).not.toContain(old)
      expect(written).not.toContain(secret)
    })

    it("counts current-code guesses against the same limit as turning 2FA off", async () => {
      h.rate.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 })
      expect((await replace({ currentCode: generateTotpCode(old) })).status).toBe(429)
      expect(h.updateManyUser).not.toHaveBeenCalled()
    })

    it("replaces the secret only if it is still the one the code was checked against, signs the user out, and audits", async () => {
      const res = await replace({ currentCode: generateTotpCode(old) })
      expect(await res.json()).toEqual({ ok: true, signInAgain: true })
      expect(h.claim).toHaveBeenCalledWith("u1", expect.any(Number))
      expect(h.updateManyUser).toHaveBeenCalledWith({
        where: { id: "u1", tenantId: "t1", totpEnabled: true, totpSecret: old },
        data: { totpSecret: secret, totpEnabled: true, lastTotpCounter: null, tokenVersion: { increment: 1 } },
      })
      expect(h.auditCreate.mock.calls[0]![0].data).toMatchObject({
        action: "TOTP_REPLACED", userId: "u1", entityId: "u1", oldValue: { totpEnabled: true }, newValue: { totpEnabled: true },
      })
      const written = JSON.stringify(h.auditCreate.mock.calls)
      expect(written).not.toContain(secret)
      expect(written).not.toContain(old)
    })

    it("answers 409 if the secret changed under it (a concurrent replace)", async () => {
      h.updateManyUser.mockResolvedValue({ count: 0 })
      expect((await replace({ currentCode: generateTotpCode(old) })).status).toBe(409)
      expect(h.auditCreate).not.toHaveBeenCalled()
    })
  })

  it("answers 409 if the account became enrolled between the read and the write", async () => {
    h.updateManyUser.mockResolvedValue({ count: 0 })
    expect((await POST(req("POST", body()))).status).toBe(409)
    expect(h.auditCreate).not.toHaveBeenCalled()
  })
})
