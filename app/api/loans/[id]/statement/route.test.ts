import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The staff statement of an entity-borrower loan. The access-log row is
// written before rendering; its IP is the one the trusted proxy saw. Prisma,
// the staff guard and the renderer are stubbed.
const m = vi.hoisted(() => ({
  loanFindUnique: vi.fn(),
  accessLogCreate: vi.fn(),
  render: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: m.loanFindUnique },
    documentAccessLog: { create: m.accessLogCreate },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: async () => ({ user: { id: "staff-1", email: "s@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } }),
}))
vi.mock("@/lib/asset-finance/documents/statement-pdf", () => ({ renderEntityStatementPdf: m.render }))

import { GET } from "./route"

const get = (headers: Record<string, string>) =>
  GET(new NextRequest("http://localhost/api/loans/loan-1/statement", { headers }), { params: Promise.resolve({ id: "loan-1" }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  m.loanFindUnique.mockResolvedValue({ id: "loan-1", clientId: null, client: null, entityId: "ent-1" })
  m.render.mockResolvedValue({ kind: "rendered", bytes: Buffer.from("%PDF"), filename: "statement.pdf" })
})

describe("GET /api/loans/[id]/statement (entity borrower)", () => {
  it("logs the access with the trusted proxy's address before rendering", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const res = await get({ "x-forwarded-for": "198.51.100.7, 203.0.113.9", "user-agent": "vitest" })
    expect(res.status).toBe(200)
    expect(m.accessLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "loan-1", accessorId: "staff-1", ipAddress: "203.0.113.9", userAgent: "vitest" }),
    })
    expect(m.accessLogCreate.mock.invocationCallOrder[0]).toBeLessThan(m.render.mock.invocationCallOrder[0])
  })

  it("records no IP from a caller-written X-Forwarded-For when no proxy is trusted", async () => {
    await get({ "x-forwarded-for": "198.51.100.7" })
    expect(m.accessLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ ipAddress: null }) })
  })
})
