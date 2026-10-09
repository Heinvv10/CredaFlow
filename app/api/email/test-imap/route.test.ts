/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const testImapLoginMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }),
}))
vi.mock("@/lib/email/inbound-poll", () => ({ testImapLogin: (...a: any[]) => testImapLoginMock(...a) }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: { EMAIL_IMAP_TESTED: "EMAIL_IMAP_TESTED" } }))

const emailConfigFindUniqueMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: { emailConfig: { findUnique: (...a: any[]) => emailConfigFindUniqueMock(...a) } },
}))

import { POST } from "./route"

const req = () => new NextRequest("http://localhost/api/email/test-imap", { method: "POST" })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@acme-lending.example" } })
  testImapLoginMock.mockResolvedValue({ ok: true, message: "Connected to imap.test — INBOX has 3 message(s)." })
  emailConfigFindUniqueMock.mockResolvedValue({ id: "cfg-1" })
})

describe("POST /api/email/test-imap", () => {
  it("is ADMIN-only", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response("no", { status: 403 }) })
    expect((await POST(req())).status).toBe(403)
    expect(testImapLoginMock).not.toHaveBeenCalled()
  })

  it("runs the login check for the resolved tenant and returns the result", async () => {
    const body = await (await POST(req())).json()
    expect(testImapLoginMock).toHaveBeenCalledWith("t1")
    expect(body).toEqual({ ok: true, message: "Connected to imap.test — INBOX has 3 message(s)." })
  })

  it("audits every attempt, success or failure", async () => {
    const { logAudit } = await import("@/lib/audit")
    testImapLoginMock.mockResolvedValue({ ok: false, message: "Invalid credentials" })
    await POST(req())
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMAIL_IMAP_TESTED",
        tenantId: "t1",
        entity: "EmailConfig",
        entityId: "cfg-1",
        newValue: { ok: false, message: "Invalid credentials" },
      }),
    )
  })

  it("falls back to the tenant id when no EmailConfig row exists", async () => {
    const { logAudit } = await import("@/lib/audit")
    emailConfigFindUniqueMock.mockResolvedValue(null)
    await POST(req())
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "t1" }),
    )
  })
})
