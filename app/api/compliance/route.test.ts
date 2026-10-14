import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findManyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      findMany: (args: unknown) => findManyMock(args),
    },
  },
}))

import * as routeModule from "./route"

const { GET } = routeModule

describe("/api/compliance write methods", () => {
  it("does not export POST, so Next answers 405 and no record can be hand-created", () => {
    expect((routeModule as Record<string, unknown>).POST).toBeUndefined()
  })
})

describe("GET /api/compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1" } })
    findManyMock.mockResolvedValue([{
      id: "notice-1",
      type: "SECTION_129_NOTICE",
      status: "PENDING",
      referenceId: "loan-1",
      dueDate: null,
      completedAt: null,
      createdAt: new Date("2026-07-20T08:00:00.000Z"),
      idempotencyKey: "tenant-1:SECTION_129_NOTICE:loan-1",
      data: {
        lifecycle: "RECONCILIATION_REQUIRED",
        clientName: "Regulated Person",
        clientIdNumber: "9001015000088",
        clientEmail: "private@example.test",
        storagePath: "/absolute/private/legal/notice.pdf",
        arrearsAmount: 123_456,
      },
    }])
  })

  it("returns a safe READONLY projection without Section 129 PII or storage metadata", async () => {
    const response = await GET(new NextRequest("https://staging.example.test/api/compliance"))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual([{
      id: "notice-1",
      type: "SECTION_129_NOTICE",
      status: "PENDING",
      referenceId: "loan-1",
      dueDate: null,
      completedAt: null,
      createdAt: "2026-07-20T08:00:00.000Z",
      data: { lifecycle: "RECONCILIATION_REQUIRED" },
    }])
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain("Regulated Person")
    expect(serialised).not.toContain("9001015000088")
    expect(serialised).not.toContain("private@example.test")
    expect(serialised).not.toContain("storagePath")
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ idempotencyKey: true }),
    }))
  })
})
