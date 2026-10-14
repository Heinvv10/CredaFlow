import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const createMock = vi.fn()
const findManyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
const logAuditMock = vi.fn()
vi.mock("@/lib/audit", () => ({ logAudit: (args: unknown) => logAuditMock(args) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      create: (args: unknown) => createMock(args),
      findMany: (args: unknown) => findManyMock(args),
    },
  },
}))

import { GET, POST } from "./route"

function request(body: unknown) {
  return new NextRequest("https://staging.example.test/api/compliance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1" } })
    createMock.mockResolvedValue({ id: "record-1" })
  })

  it("rejects a forged Section 129 issued record from the generic endpoint", async () => {
    const response = await POST(request({
      type: "SECTION_129_NOTICE",
      status: "COMPLETED",
      referenceId: "loan-1",
      data: { lifecycle: "ISSUED" },
    }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "SECTION_129_NOTICE records must be created through the dedicated loan collections workflow.",
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it("rejects a forged agreement artifact record from the generic endpoint", async () => {
    const response = await POST(request({
      type: "AGREEMENT_ARTIFACT",
      status: "COMPLETED",
      referenceId: "app-1",
      data: { lifecycle: "COMPLETED" },
    }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "AGREEMENT_ARTIFACT records must be created through the dedicated agreement generation workflow.",
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it.each([
    "CREDIT_BUREAU_CHECK",
    "NCR_QUARTERLY_RETURN",
    "FSCA_QUARTERLY_RETURN",
    "FAIS_DISCLOSURE",
    "DISBURSEMENT_EXCEPTION",
    "KYC_EXCEPTION",
    "DEBIT_MANDATE_ARTIFACT",
    "NOT_A_TYPE",
  ])("rejects system-written type %s", async (type) => {
    const response = await POST(request({
      type,
      status: "COMPLETED",
      referenceId: "app-1",
      data: { score: 999, reviewGeneration: "gen-1" },
    }))

    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain(type)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("continues to create a manual (legacy) record and audits it", async () => {
    createMock.mockResolvedValue({ id: "record-1", type: "POPIA_CONSENT", status: "PENDING", referenceId: null })
    const response = await POST(request({ type: "POPIA_CONSENT", status: "PENDING" }))

    expect(response.status).toBe(200)
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant-1", type: "POPIA_CONSENT" }),
    }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", userId: "admin-1", entityId: "record-1", action: "COMPLIANCE_RECORD_CREATED",
    }))
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
