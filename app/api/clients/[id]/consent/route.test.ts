import { beforeEach, describe, expect, it, vi } from "vitest"

const requireApiRoleMock = vi.fn()
const getDefaultTenantIdMock = vi.fn()
const clientFindFirstMock = vi.fn()
const consentFindUniqueMock = vi.fn()
const consentUpsertMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => getDefaultTenantIdMock() }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    clientConsent: {
      findUnique: (a: unknown) => consentFindUniqueMock(a),
      upsert: (a: unknown) => consentUpsertMock(a),
    },
  }
  return {
    prisma: {
      client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
      clientConsent: { findUnique: (a: unknown) => consentFindUniqueMock(a) },
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  }
})
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { PUT } from "./route"

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/clients/c1/consent", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "c1" }) },
  )
}

describe("PUT /api/clients/[id]/consent — tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "u1", email: "admin@acme-lending.example", role: "LOAN_ADMIN", tenantId: "tenant-a" },
    })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
    consentFindUniqueMock.mockResolvedValue(null)
    consentUpsertMock.mockResolvedValue({ id: "consent-1" })
  })

  it("looks the client up in the staff user's tenant, not the default", async () => {
    clientFindFirstMock.mockResolvedValue({ id: "c1", tenantId: "tenant-a" })

    const res = await put({ emailMarketing: true })

    expect(res?.status).toBe(200)
    expect(clientFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "tenant-a" } }))
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
  })

  it("audits the consent change under the staff user's tenant", async () => {
    clientFindFirstMock.mockResolvedValue({ id: "c1", tenantId: "tenant-a" })

    await put({ emailMarketing: true })

    expect(logAuditMock).toHaveBeenCalled()
    for (const [arg] of logAuditMock.mock.calls) {
      expect(arg).toMatchObject({ tenantId: "tenant-a" })
    }
  })

  it("returns 404 and writes nothing for a client id belonging to another tenant", async () => {
    clientFindFirstMock.mockResolvedValue(null)

    const res = await put({ emailMarketing: true })

    expect(res?.status).toBe(404)
    expect(consentUpsertMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
