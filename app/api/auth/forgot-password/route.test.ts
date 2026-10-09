import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const findUniqueMock = vi.fn()
const updateMock = vi.fn()
const legacySendEmailMock = vi.fn()
const sendEmailMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
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
