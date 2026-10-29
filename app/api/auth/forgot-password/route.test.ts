import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const findUniqueMock = vi.fn()
const updateMock = vi.fn()
const auditCreateMock = vi.fn()
const legacySendEmailMock = vi.fn()
const sendEmailMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({ user: { update: updateMock }, auditLog: { create: auditCreateMock } }),
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}))

vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => legacySendEmailMock(...args),
  passwordResetEmailHtml: () => "<p>Reset password</p>",
}))

vi.mock("@/lib/email/service", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}))

vi.mock("@/lib/config/identity", () => ({
  getLenderBrandName: async () => "Acme Lending",
}))

vi.mock("@/lib/rate-limit", () => ({
  callerIp: () => "127.0.0.1",
  checkRateLimit: () => ({ allowed: true }),
}))

import { POST } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
  findUniqueMock.mockResolvedValue({
    id: "user-1",
    tenantId: "tenant-1",
    name: "Staff User",
    email: "staff@example.com",
    active: true,
  })
  auditCreateMock.mockResolvedValue({ id: "audit-synthetic" })
  updateMock.mockResolvedValue(undefined)
  legacySendEmailMock.mockResolvedValue({ ok: true })
  sendEmailMock.mockResolvedValue({
    ok: true,
    provider: "SMTP",
    providerOutcome: "ACCEPTED",
    messageId: "smtp-1",
  })
})

it("sends staff password resets through the tenant SMTP service", async () => {
  const req = new NextRequest("http://localhost/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "staff@example.com" }),
    headers: { "content-type": "application/json" },
  })

  const response = await POST(req)

  expect(response.status).toBe(200)
  expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: "tenant-1",
    to: "staff@example.com",
    subject: "Reset your Acme Lending password",
    category: "staff-password-reset",
    referenceId: "user-1",
  }))
  expect(legacySendEmailMock).not.toHaveBeenCalled()
})


it("never sends a reset link if the token audit fails", async () => {
  auditCreateMock.mockRejectedValue(new Error("audit unavailable"))
  const req = new NextRequest("http://localhost/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: "staff@example.com" }) })
  await expect(POST(req)).rejects.toThrow("audit unavailable")
  expect(sendEmailMock).not.toHaveBeenCalled()
})

// A user bound to the lender's identity provider while SSO is on: their password is not a way in, so no reset is issued.
const forgot = () => POST(new NextRequest("http://localhost/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: "staff@example.com" }) }))
const asUser = (over: Record<string, unknown>) => findUniqueMock.mockResolvedValue({
  id: "user-1", tenantId: "tenant-1", name: "Staff User", email: "staff@example.com", active: true, role: "CREDIT_OFFICER", ...over,
})
const sso = (enabled: boolean) => ({ ssoConnection: { enabled } })

it("issues no reset token and sends no email to an SSO-bound user while SSO is on, and still answers 200", async () => {
  asUser({ ssoIdentity: { id: "link-1" }, tenant: sso(true) })
  const response = await forgot()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(updateMock).not.toHaveBeenCalled()
  expect(auditCreateMock).not.toHaveBeenCalled()
  expect(sendEmailMock).not.toHaveBeenCalled()
})

it.each([
  ["SSO is switched off", { ssoIdentity: { id: "link-1" }, tenant: sso(false) }],
  ["the user was never bound", { ssoIdentity: null, tenant: sso(true) }],
  ["the lender has no connection", { ssoIdentity: { id: "link-1" }, tenant: { ssoConnection: null } }],
  ["the user is a Super Admin (the break-glass path)", { role: "SUPER_ADMIN", ssoIdentity: { id: "link-1" }, tenant: sso(true) }],
])("still resets when %s", async (_label, over) => {
  asUser(over)
  expect((await forgot()).status).toBe(200)
  expect(updateMock).toHaveBeenCalledOnce()
  expect(sendEmailMock).toHaveBeenCalledOnce()
})
