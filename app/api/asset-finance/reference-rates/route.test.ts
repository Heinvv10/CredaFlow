import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  create: vi.fn(),
  logAuditStrict: vi.fn(),
  requireAssetFinanceEnabled: vi.fn(),
}))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: m.requireAssetFinanceEnabled }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: m.requireApiRole,
  canDo: (role: string) => role === "LOAN_ADMIN",
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => unknown) => handler({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({ referenceRate: { create: m.create } }) },
}))
vi.mock("@/lib/audit", () => ({ AuditAction: { REFERENCE_RATE_RECORDED: "REFERENCE_RATE_RECORDED" }, logAuditStrict: m.logAuditStrict }))

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/asset-finance/reference-rates", { method: "POST", body: JSON.stringify(body) }))
const VALID = { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" }

describe("POST /api/asset-finance/reference-rates", () => {
  beforeEach(() => {
    m.requireApiRole.mockReset().mockResolvedValue({ user: { id: "u1", email: "admin@test.invalid", role: "LOAN_ADMIN" } })
    m.logAuditStrict.mockReset()
    m.requireAssetFinanceEnabled.mockReset().mockResolvedValue(null)
    m.create.mockReset().mockImplementation(async ({ data }: { data: { basis: string; effectiveDate: Date; rate: Prisma.Decimal } }) => ({
      id: "rr1", ...data, createdById: "u1", createdAt: new Date("2027-01-10T08:00:00Z"),
    }))
  })

  it("answers 404 and writes nothing when the tenant has not enabled asset finance", async () => {
    m.requireAssetFinanceEnabled.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }))
    expect((await post(VALID)).status).toBe(404)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("passes through the role guard's refusal", async () => {
    m.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await post(VALID)).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("answers 400 with the fields at fault and writes nothing", async () => {
    const response = await post({ ...VALID, rate: "12" })
    expect(response.status).toBe(400)
    expect((await response.json()).fields).toHaveProperty("rate")
    expect(m.create).not.toHaveBeenCalled()
  })

  it("records the rate and its audit row in one transaction", async () => {
    const response = await post(VALID)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "rr1", basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" })
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", userId: "u1", action: "REFERENCE_RATE_RECORDED", entityId: "rr1", newValue: { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" } }),
      expect.anything(),
    )
  })

  it("answers 409 to a second value for the same basis and date", async () => {
    m.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" }))
    expect((await post(VALID)).status).toBe(409)
  })
})
