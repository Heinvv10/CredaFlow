import { describe, it, expect, vi, beforeEach } from "vitest"

const authMock = vi.fn()
const transactionMock = vi.fn()
const logAuditMock = vi.fn()

// The REAL requireMinRole runs here (not mocked): the point is that a portal
// CLIENT session, which passes a bare `session?.user` check, is refused.
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: unknown) => transactionMock(fn),
    loan: { findMany: vi.fn() },
    crossSellOpportunity: { findMany: vi.fn(), createMany: vi.fn() },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  logAuditStrict: vi.fn(),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT:${p}`)
  },
}))

import { generateCrossSellOpportunities, updateLeadStatus, addLeadActivity } from "./crm"
import { toggleLeadActivityPinned } from "./lead-activities"

describe("lead/CRM actions refuse a portal CLIENT session", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({ user: { id: "c1", email: "client@example.test", role: "CLIENT", tenantId: "t1" } })
  })

  it.each([
    ["generateCrossSellOpportunities", () => generateCrossSellOpportunities()],
    ["updateLeadStatus", () => updateLeadStatus("lead-1", "QUALIFIED")],
    ["addLeadActivity", () => addLeadActivity({ leadId: "lead-1", type: "NOTE", subject: "s" })],
    ["toggleLeadActivityPinned", () => toggleLeadActivityPinned("a1", true)],
  ])("%s", async (_name, call) => {
    await expect(call()).rejects.toThrow("NEXT_REDIRECT")
    expect(transactionMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("a role below CREDIT_OFFICER is refused too", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "r@acme-lending.example", role: "READONLY", tenantId: "t1" } })
    await expect(updateLeadStatus("lead-1", "QUALIFIED")).rejects.toThrow("NEXT_REDIRECT")
  })
})
