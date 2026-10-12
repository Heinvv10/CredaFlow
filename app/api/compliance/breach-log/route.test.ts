import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findManyMock = vi.fn()
const createMock = vi.fn()
const auditCreateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
// The real lib/audit.ts runs against this mock, so the audit row is asserted
// as written, on the transaction client the breach row was written on.
vi.mock("@/lib/prisma", () => {
  const tx = {
    breachLog: { create: (a: unknown) => createMock(a) },
    auditLog: { create: (a: unknown) => auditCreateMock(a) },
  }
  return {
    prisma: {
      breachLog: { findMany: (a: unknown) => findManyMock(a) },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  }
})

import { GET, POST } from "./route"

const URL = "https://staging.example.test/api/compliance/breach-log"
const get = () => new NextRequest(URL)
const post = (body: unknown) => new NextRequest(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const incident = {
  incidentDate: "2026-09-01",
  discoveredDate: "2026-09-02",
  description: "Synthetic mailbox exposure drill.",
  affectedClients: 3,
  dataCategories: "Contact details",
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
  findManyMock.mockResolvedValue([])
  createMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "breach-1", ...data }))
  auditCreateMock.mockResolvedValue({})
})

describe("GET /api/compliance/breach-log", () => {
  it("lists only the caller's tenant's entries", async () => {
    findManyMock.mockResolvedValue([{ id: "breach-1" }])
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: "breach-1" }])
    expect(findManyMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      orderBy: { incidentDate: "desc" },
    })
  })

  it("requires LOAN_ADMIN and reads nothing when the guard refuses", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await GET(get())
    expect(res.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(findManyMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/compliance/breach-log", () => {
  it("stamps the entry with the caller's tenant, never one from the body", async () => {
    const res = await POST(post({ ...incident, tenantId: "tenant-2" }))
    expect(res.status).toBe(201)
    expect(createMock.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      status: "OPEN",
      createdBy: "admin-1",
      affectedClients: 3,
    })
  })

  it("audits the entry with the register row, without its free-text description", async () => {
    await POST(post(incident))
    expect(auditCreateMock).toHaveBeenCalledTimes(1)
    const audit = auditCreateMock.mock.calls[0][0].data
    expect(audit).toMatchObject({
      tenantId: "tenant-1",
      userId: "admin-1",
      userEmail: "admin@example.test",
      action: "BREACH_LOG_CREATED",
      entity: "BreachLog",
      entityId: "breach-1",
      newValue: {
        incidentDate: new Date("2026-09-01"),
        discoveredDate: new Date("2026-09-02"),
        affectedClients: 3,
        dataCategories: "Contact details",
        reportedToIC: false,
        reportedAt: null,
        status: "OPEN",
      },
    })
    expect(JSON.stringify(audit)).not.toContain("Synthetic mailbox exposure drill.")
  })

  it("fails closed when the audit row cannot be written", async () => {
    auditCreateMock.mockRejectedValue(new Error("audit unavailable"))
    const res = await POST(post(incident))
    expect(res.status).toBe(500)
  })

  it("rejects an entry with a required field missing, writing nothing", async () => {
    const res = await POST(post({ ...incident, description: "" }))
    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("requires LOAN_ADMIN and writes nothing when the guard refuses", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await POST(post(incident))
    expect(res.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(createMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })
})
