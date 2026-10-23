import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Route, role guard and flag gate are real; session, Prisma and audit stubbed.
const m = vi.hoisted(() => ({
  session: { role: "CREDIT_OFFICER" as string },
  flag: { on: true },
  tx: { entityRelationship: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() } },
  entityFindFirst: vi.fn(),
  clientFindFirst: vi.fn(),
  peopleFindMany: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    businessEntity: { findFirst: m.entityFindFirst },
    client: { findFirst: m.clientFindFirst },
    entityRelationship: { findMany: m.peopleFindMany },
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

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/asset-finance/entities/ent-1/people", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "ent-1" }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "CREDIT_OFFICER"
  m.flag.on = true
  m.entityFindFirst.mockResolvedValue({ id: "ent-1", type: "TRUST" })
  m.clientFindFirst.mockResolvedValue({ id: "client-1", reference: "CLI-TEST-1" })
  m.peopleFindMany.mockResolvedValue([])
  m.tx.entityRelationship.findMany.mockResolvedValue([])
  let n = 0
  m.tx.entityRelationship.create.mockImplementation(async () => ({ id: `rel-${++n}` }))
  m.tx.entityRelationship.update.mockResolvedValue({ id: "rel-old" })
})

describe("POST /api/asset-finance/entities/[id]/people", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await post({ clientId: "client-1", roles: ["SURETY"] })).status).toBe(404)
  })

  it("refuses READONLY 403 and writes nothing", async () => {
    m.session.role = "READONLY"
    expect((await post({ clientId: "client-1", roles: ["SURETY"] })).status).toBe(403)
    expect(m.tx.entityRelationship.create).not.toHaveBeenCalled()
  })

  it("answers 400 for a trustee without a kind, and for a role the entity type does not take", async () => {
    expect((await post({ clientId: "client-1", roles: ["TRUSTEE"] })).status).toBe(400)
    expect((await post({ clientId: "client-1", roles: ["DIRECTOR"] })).status).toBe(400)
    expect(m.tx.entityRelationship.create).not.toHaveBeenCalled()
  })

  it("answers 400 for a client outside the tenant", async () => {
    m.clientFindFirst.mockResolvedValue(null)
    expect((await post({ clientId: "other", roles: ["SURETY"] })).status).toBe(400)
    expect(m.clientFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other", tenantId: "tenant-1" } }))
  })

  it("writes one row and one audit entry per role, the trustee kind only on the TRUSTEE row", async () => {
    const res = await post({ clientId: "client-1", roles: ["TRUSTEE", "SURETY"], trusteeKind: "NATURAL" })
    expect(res.status).toBe(201)
    expect(m.tx.entityRelationship.create).toHaveBeenCalledTimes(2)
    expect(m.tx.entityRelationship.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", entityId: "ent-1", clientId: "client-1", role: "TRUSTEE", trusteeKind: "NATURAL", ownershipPct: null },
      select: { id: true },
    })
    expect(m.tx.entityRelationship.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", entityId: "ent-1", clientId: "client-1", role: "SURETY", trusteeKind: null, ownershipPct: null },
      select: { id: true },
    })
    expect(m.logAuditStrict).toHaveBeenCalledTimes(2)
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTITY_RELATIONSHIP_ADDED", entityId: "rel-1", newValue: expect.objectContaining({ role: "TRUSTEE" }) }),
      m.tx,
    )
  })

  it("reactivates a role the person held before", async () => {
    m.tx.entityRelationship.findMany.mockResolvedValue([{ id: "rel-old", role: "SURETY", active: false }])
    expect((await post({ clientId: "client-1", roles: ["SURETY"] })).status).toBe(201)
    expect(m.tx.entityRelationship.update).toHaveBeenCalledWith({
      where: { id: "rel-old", tenantId: "tenant-1" },
      data: { trusteeKind: null, ownershipPct: null, active: true },
      select: { id: true },
    })
    expect(m.tx.entityRelationship.create).not.toHaveBeenCalled()
  })

  it("names the dealer draft purge when the person or business was erased, not an approved deal", async () => {
    m.tx.entityRelationship.create.mockRejectedValue(new Error("ERROR: 23514: An erased person or business is not used again"))
    const res = await post({ clientId: "client-1", roles: ["SURETY"] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/erased by the dealer draft purge/)
    m.tx.entityRelationship.create.mockRejectedValue(new Error("ERROR: 23514: EntityRelationship_fixed_on_open_deal"))
    expect((await (await post({ clientId: "client-1", roles: ["SURETY"] })).json()).error).toMatch(/approved deal/)
  })

  it("answers 409 for a role the person holds now, and writes nothing", async () => {
    m.tx.entityRelationship.findMany.mockResolvedValue([{ id: "rel-old", role: "SURETY", active: true }])
    expect((await post({ clientId: "client-1", roles: ["SURETY", "AUTHORISED_SIGNATORY"] })).status).toBe(409)
    expect(m.tx.entityRelationship.create).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })
})
