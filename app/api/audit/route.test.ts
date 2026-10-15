import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { authMock, findManyMock, countMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findManyMock: vi.fn(),
  countMock: vi.fn(),
}))

// The real role guard runs; only the session is supplied.
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { findMany: (a: unknown) => findManyMock(a), count: (a: unknown) => countMock(a) } },
}))

import { GET } from "./route"

const session = (role: string) => ({ user: { id: `u-${role}`, email: "x@test.invalid", role, tenantId: "t1" } })
const EXCLUSION = { NOT: [{ entity: "SuspiciousReportCase" }, { action: { startsWith: "STR_" } }] }

beforeEach(() => {
  vi.clearAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

describe("GET /api/audit — STR tipping off (H4)", () => {
  it("hides STR case rows and STR_* actions from LOAN_ADMIN and BRANCH_MANAGER, in the rows and the count", async () => {
    for (const role of ["LOAN_ADMIN", "BRANCH_MANAGER"]) {
      authMock.mockResolvedValue(session(role))
      const res = await GET(new NextRequest("http://x/api/audit?entity=SuspiciousReportCase"))
      expect(res.status, role).toBe(200)
      expect(findManyMock).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { tenantId: "t1", entity: "SuspiciousReportCase", AND: [EXCLUSION] },
      }))
      expect(countMock).toHaveBeenLastCalledWith({ where: { tenantId: "t1", entity: "SuspiciousReportCase", AND: [EXCLUSION] } })
    }
  })

  it("shows them to the FIC compliance role", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      authMock.mockResolvedValue(session(role))
      await GET(new NextRequest("http://x/api/audit"))
      expect(findManyMock).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }))
    }
  })
})
