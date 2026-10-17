import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findUnique: vi.fn(), load: vi.fn(), requireApiRole: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => m.requireApiRole() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_r: unknown, h: (t: { id: string }) => unknown) => h({ id: "t1" }) }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findUnique: (a: unknown) => m.findUnique(a) } } }))
vi.mock("@/lib/affordability/own-lender-debt-load", () => ({ loadOwnLenderDebts: (...a: unknown[]) => m.load(...a) }))

import { GET } from "./route"

const get = () => GET(new NextRequest("http://localhost/api/clients/c1/own-lender-debts"), { params: Promise.resolve({ id: "c1" }) })

beforeEach(() => {
  vi.clearAllMocks()
  m.requireApiRole.mockResolvedValue({ user: { id: "u1", role: "CREDIT_OFFICER" } })
  m.findUnique.mockResolvedValue({ id: "c1", debtObligations: [{ id: "d1", creditProvider: "Store account", monthlyInstalment: 87_000 }] })
  m.load.mockResolvedValue({
    lenderNames: ["Fair Score"],
    loans: [{ id: "l1", reference: "LN-1", status: "ACTIVE", instalmentCents: 254_100, outstandingPrincipal: 1, daysInArrears: 27, arrearsAmount: 84_330 }],
  })
})

describe("GET /api/clients/[id]/own-lender-debts", () => {
  it("reads the one selected client: declared debts plus obligations to this lender, and its arrears", async () => {
    const res = await get()
    expect(await res.json()).toEqual({
      debtObligations: [{ monthlyInstalment: 87_000 }, { monthlyInstalment: 254_100 }],
      ownLenderArrears: { days: 27, amountCents: 84_330 },
    })
    expect(m.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }))
    expect(m.load).toHaveBeenCalledWith(expect.anything(), "t1", "c1")
  })

  it("answers 404 for a client of another tenant", async () => {
    m.findUnique.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(m.load).not.toHaveBeenCalled()
  })
})
