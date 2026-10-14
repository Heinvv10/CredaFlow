import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

// The route, the role guard (lib/auth-guards) and the flag gate run for real;
// the session, Prisma and the audit writer are stubbed.
const m = vi.hoisted(() => ({
  session: { role: "CREDIT_OFFICER" as string },
  flag: { on: true },
  tx: { businessEntity: { create: vi.fn() } },
  findMany: vi.fn(),
  findFirst: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    businessEntity: { findMany: m.findMany, findFirst: m.findFirst },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { GET, POST } from "./route"

const VALID = { type: "COMPANY", legalName: "TEST Synthetic Plant Hire (Pty) Ltd", registrationNumber: "2015/123456/07" }
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/asset-finance/entities", { method: "POST", body: JSON.stringify(body) }))
const get = () => GET(new NextRequest("http://localhost/api/asset-finance/entities"))

const coreRow = {
  id: "ent-1", ...VALID, tradingName: null, mastersReference: null, vatNumber: null, annualTurnover: null,
  totalAssetValue: null, financialYearEnd: null, financialsEvidenceIds: [], addressLine1: null, addressLine2: null,
  city: null, province: null, postalCode: null, createdAt: new Date("2026-10-13T08:00:00Z"), updatedAt: new Date("2026-10-13T08:00:00Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "CREDIT_OFFICER"
  m.flag.on = true
  m.tx.businessEntity.create.mockResolvedValue({ id: "ent-1" })
  m.findFirst.mockResolvedValue(coreRow)
  m.findMany.mockResolvedValue([])
})

describe("GET /api/asset-finance/entities", () => {
  it("answers 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await get()).status).toBe(404)
    expect(m.findMany).not.toHaveBeenCalled()
  })

  it("lists the tenant's entities to any staff role", async () => {
    m.session.role = "READONLY"
    m.findMany.mockResolvedValue([{ ...coreRow, _count: { relationships: 2, documents: 3 } }])
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([expect.objectContaining({ id: "ent-1", activePeople: 2, documents: 3 })])
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }))
  })
})

describe("POST /api/asset-finance/entities", () => {
  it("answers 404 and writes nothing when the flag is off", async () => {
    m.flag.on = false
    expect((await post(VALID)).status).toBe(404)
    expect(m.tx.businessEntity.create).not.toHaveBeenCalled()
  })

  it("refuses READONLY 403 and writes nothing", async () => {
    m.session.role = "READONLY"
    expect((await post(VALID)).status).toBe(403)
    expect(m.tx.businessEntity.create).not.toHaveBeenCalled()
  })

  it("answers 400 with the fields at fault", async () => {
    const res = await post({ ...VALID, registrationNumber: "12345" })
    expect(res.status).toBe(400)
    expect((await res.json()).fields).toHaveProperty("registrationNumber")
    expect(m.tx.businessEntity.create).not.toHaveBeenCalled()
  })

  it("creates the entity for the tenant with its audit row in the same transaction", async () => {
    const res = await post({ ...VALID, annualTurnover: 150_000_000, financialYearEnd: "2026-02-28" })
    expect(res.status).toBe(201)
    expect(m.tx.businessEntity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-1", type: "COMPANY", annualTurnover: 150_000_000, createdById: "user-1" }),
      select: { id: true },
    })
    // financialsEvidenceIds is never taken from the body.
    expect(m.tx.businessEntity.create.mock.calls[0][0].data).not.toHaveProperty("financialsEvidenceIds")
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: "BUSINESS_ENTITY_CREATED", entity: "BusinessEntity", entityId: "ent-1", userId: "user-1" }),
      m.tx,
    )
  })

  it("answers 409 for a registration number already on the books", async () => {
    m.tx.businessEntity.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" }))
    expect((await post(VALID)).status).toBe(409)
  })
})
