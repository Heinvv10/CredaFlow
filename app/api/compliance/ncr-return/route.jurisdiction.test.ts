import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getNcrReturnDataMock = vi.fn()
const createMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => Promise.resolve({ user: { id: "u1" } }) }))
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve({ user: { id: "u1", email: "u@example.test" } }) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { complianceRecord: { findFirst: vi.fn(), create: (a: unknown) => createMock(a) } },
}))
vi.mock("@/lib/compliance/ncr-return", async () => ({
  ...(await vi.importActual<object>("@/lib/compliance/ncr-return")),
  getNcrReturnData: (...a: unknown[]) => getNcrReturnDataMock(...a),
}))

import * as route from "./route"
import { defaultQuarter } from "@/lib/compliance/quarters"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

afterEach(() => {
  resetActiveJurisdiction()
  vi.clearAllMocks()
})

describe("NCR return routes outside the NCA's jurisdiction", () => {
  it("GET and POST answer 404 and touch nothing for an LS lender", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const get = await route.GET(new NextRequest("http://localhost/api/compliance/ncr-return"))
    const post = await route.POST(new NextRequest("http://localhost/api/compliance/ncr-return", {
      method: "POST",
      body: JSON.stringify({ quarter: defaultQuarter() }),
    }))
    expect(get.status).toBe(404)
    expect(post.status).toBe(404)
    expect(getNcrReturnDataMock).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it("GET still serves a ZA lender", async () => {
    getNcrReturnDataMock.mockResolvedValue({ quarter: "x" })
    const get = await route.GET(new NextRequest("http://localhost/api/compliance/ncr-return"))
    expect(get.status).toBe(200)
  })
})
