import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const db = vi.hoisted(() => ({
  paymentPlan: { findUnique: vi.fn(), upsert: vi.fn() },
  loanNote: { create: vi.fn() },
}))
vi.mock("@/lib/prisma", () => ({ prisma: db }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { ...actual, logAudit: vi.fn() }
})

import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/loans/L1/payment-plan", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "L1" }) })

describe("POST /api/loans/[id]/payment-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "t1" } as never))
    db.paymentPlan.findUnique.mockResolvedValue(null)
    db.paymentPlan.upsert.mockImplementation(async ({ create }) => ({ id: "p1", ...create }))
  })

  // Audit row 114: R2,058.34 over 3 was stored as 3 x R686.11 = R2,058.33.
  it("persists the exact arrears and the regular instalment, and names the larger final instalment", async () => {
    // The client sends a float instalment; the server must not trust it.
    const res = await post({ totalArrears: 2058.34, installments: 3, installmentAmt: 686.1133333, startDate: "2026-11-01" })
    expect(res.status).toBe(201)
    const data = db.paymentPlan.upsert.mock.calls[0][0].create
    expect(data.totalArrears).toBe(205_834)
    expect(data.installmentAmt).toBe(68_611)
    expect(data.installmentAmt * 2 + 68_612).toBe(data.totalArrears)
    const note = db.loanNote.create.mock.calls[0][0].data.note as string
    expect(note).toContain("2 × R686.11")
    expect(note).toContain("final instalment R686.12")
  })

  it("keeps the audit entry shape unchanged", async () => {
    await post({ totalArrears: 2058.34, installments: 3, startDate: "2026-11-01" })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "PAYMENT_PLAN_UPSERTED",
      entity: "Loan",
      entityId: "L1",
      newValue: expect.objectContaining({ totalArrears: 205_834, installments: 3, installmentAmt: 68_611 }),
    }))
  })

  it("an even split keeps the simple note", async () => {
    await post({ totalArrears: 3000, installments: 3, startDate: "2026-11-01" })
    expect(db.loanNote.create.mock.calls[0][0].data.note).toContain("3 × R1000.00/month")
  })

  it("rejects a non-positive amount or a bad instalment count with 400", async () => {
    expect((await post({ totalArrears: 0, installments: 3, startDate: "2026-11-01" })).status).toBe(400)
    expect((await post({ totalArrears: 100, installments: 0, startDate: "2026-11-01" })).status).toBe(400)
    expect(db.paymentPlan.upsert).not.toHaveBeenCalled()
  })
})
