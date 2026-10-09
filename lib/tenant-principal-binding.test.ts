import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { authMock, tenantFindUniqueMock, runWithTenantMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  runWithTenantMock: vi.fn(),
}))

vi.mock("./auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}))

vi.mock("./prisma", () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args),
      findMany: vi.fn(),
    },
  },
}))

vi.mock("./tenant-scope", () => ({
  getCurrentTenantId: vi.fn(),
  runWithTenant: (...args: unknown[]) => runWithTenantMock(...args),
}))

import { withTenantContext } from "./tenant"

const tenantB = {
  id: "tenant-b-id",
  slug: "tenant-b",
  name: "Tenant B",
  domain: null,
  status: "ACTIVE" as const,
}

function request() {
  return new NextRequest("http://localhost/api/applications", {
    headers: { "x-tenant-slug": tenantB.slug },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  tenantFindUniqueMock.mockResolvedValue(tenantB)
  runWithTenantMock.mockImplementation(
    async (_tenantId: string, callback: () => unknown) => callback(),
  )
})

describe("authenticated tenant binding", () => {
  it.each(["LOAN_ADMIN", "CLIENT"] as const)(
    "rejects a tenant-A %s principal selecting tenant B",
    async (role) => {
      authMock.mockResolvedValue({
        user: { id: "principal-a", role, tenantId: "tenant-a-id" },
      })
      const handler = vi.fn()

      const response = await withTenantContext(request(), handler)

      expect(response).toBeInstanceOf(Response)
      expect((response as Response).status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
      expect(runWithTenantMock).not.toHaveBeenCalled()
    },
  )

  it("runs a matching authenticated principal inside the resolved tenant scope", async () => {
    authMock.mockResolvedValue({
      user: { id: "principal-b", role: "LOAN_ADMIN", tenantId: tenantB.id },
    })
    const handler = vi.fn().mockResolvedValue("handled")

    const result = await withTenantContext(request(), handler)

    expect(result).toBe("handled")
    expect(runWithTenantMock).toHaveBeenCalledWith(
      tenantB.id,
      expect.any(Function),
    )
    expect(handler).toHaveBeenCalledWith(tenantB)
  })

  it.each(["LOAN_ADMIN", "CLIENT"] as const)(
    "rejects a %s principal without a persisted tenant assignment",
    async (role) => {
      authMock.mockResolvedValue({
        user: { id: "principal-unassigned", role, tenantId: null },
      })
      const handler = vi.fn()

      const response = await withTenantContext(request(), handler)

      expect(response).toBeInstanceOf(Response)
      expect((response as Response).status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
      expect(runWithTenantMock).not.toHaveBeenCalled()
    },
  )

  it("continues to allow unauthenticated public routes in their host tenant", async () => {
    authMock.mockResolvedValue(null)
    const handler = vi.fn().mockResolvedValue("public")

    await expect(withTenantContext(request(), handler)).resolves.toBe("public")
  })
})
