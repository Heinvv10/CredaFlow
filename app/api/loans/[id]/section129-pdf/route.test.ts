import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const complianceRecordFindManyMock = vi.fn()
const readFileMock = vi.fn()
const logAuditStrictMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: (args: unknown) => loanFindUniqueMock(args) },
    complianceRecord: { findMany: (args: unknown) => complianceRecordFindManyMock(args) },
  },
}))
vi.mock("@/lib/storage", () => ({ readFile: (path: string) => readFileMock(path) }))
vi.mock("@/lib/audit", () => ({ logAuditStrict: (args: unknown) => logAuditStrictMock(args) }))

import { section129PdfSha256 } from "@/lib/collections/section129-artifact"
import { GET } from "./route"

const pdf = Buffer.from("%PDF-1.4 exact issued artifact")
const request = () => new NextRequest("https://staging.example.test/api/loans/L1/section129-pdf")
const context = { params: Promise.resolve({ id: "L1" }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@example.test" } })
  loanFindUniqueMock.mockResolvedValue({ id: "L1", reference: "LN-TEST" })
  complianceRecordFindManyMock.mockResolvedValue([{
    id: "ISSUE-1",
    status: "COMPLETED",
    completedAt: new Date("2026-07-18"),
    data: {
      lifecycle: "ISSUED",
      storagePath: "/private/legal/issued.pdf",
      fileName: "Section-129-Notice-LN-TEST.pdf",
      pdfSha256: section129PdfSha256(pdf),
    },
  }])
  readFileMock.mockResolvedValue(pdf)
  logAuditStrictMock.mockResolvedValue(undefined)
})

describe("GET /api/loans/[id]/section129-pdf", () => {
  it("requires the collections role", async () => {
    await GET(request(), context)
    expect(requireApiRoleMock).toHaveBeenCalledWith("COLLECTIONS_OFFICER")
  })

  it("serves the exact historical bytes even after the loan cures or settles", async () => {
    loanFindUniqueMock.mockResolvedValue({ id: "L1", reference: "LN-TEST", status: "COMPLETED" })

    const response = await GET(request(), context)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf)
    expect(readFileMock).toHaveBeenCalledWith("/private/legal/issued.pdf")
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SECTION_129_ARTIFACT_VIEWED",
      entityId: "L1",
      newValue: expect.objectContaining({ issuanceId: "ISSUE-1" }),
    }))
  })

  it("fails closed when the access audit cannot be persisted", async () => {
    logAuditStrictMock.mockRejectedValue(new Error("audit database unavailable"))

    const response = await GET(request(), context)
    const body = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(body.error).toContain("access audit")
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  it("never generates fresh bytes when no completed immutable artifact exists", async () => {
    complianceRecordFindManyMock.mockResolvedValue([])

    const response = await GET(request(), context)
    const body = await response.json() as { error: string }

    expect(response.status).toBe(409)
    expect(body.error).toContain("direct PDF generation is disabled")
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("fails closed and audits a hash mismatch", async () => {
    readFileMock.mockResolvedValue(Buffer.from("tampered"))

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SECTION_129_ARTIFACT_INTEGRITY_FAILED",
      newValue: expect.objectContaining({ issuanceId: "ISSUE-1" }),
    }))
  })

  it("returns 404 without touching compliance storage for an unknown loan", async () => {
    loanFindUniqueMock.mockResolvedValue(null)

    expect((await GET(request(), context)).status).toBe(404)
    expect(complianceRecordFindManyMock).not.toHaveBeenCalled()
  })
})
