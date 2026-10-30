import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const {
  requireOwnerOrStaffMock,
  applicationFindUniqueMock,
  documentFindFirstMock,
  accessFindFirstMock,
  readFileMock,
  transactionMock,
  applicationUpdateManyMock,
  documentUpdateManyMock,
  auditCreateMock,
} = vi.hoisted(() => ({
  requireOwnerOrStaffMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  documentFindFirstMock: vi.fn(),
  accessFindFirstMock: vi.fn(),
  readFileMock: vi.fn(),
  transactionMock: vi.fn(),
  applicationUpdateManyMock: vi.fn(),
  documentUpdateManyMock: vi.fn(),
  auditCreateMock: vi.fn(),
}))

// The key-facts redirect reads the application by its own query; these routes are exercised as PASQ applications.
vi.mock("@/lib/non-nca-documents/refusal", () => ({ keyFactsRefusal: async () => null }))
vi.mock("@/lib/auth-guards", () => ({
  requireOwnerOrStaff: (...args: unknown[]) => requireOwnerOrStaffMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findUnique: (...args: unknown[]) => applicationFindUniqueMock(...args) },
    clientDocument: { findFirst: (...args: unknown[]) => documentFindFirstMock(...args) },
    documentAccessLog: { findFirst: (...args: unknown[]) => accessFindFirstMock(...args) },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/storage", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const generatedAt = new Date("2026-07-23T08:00:00.000Z")
const viewedAt = new Date("2026-07-23T08:02:00.000Z")
const now = new Date("2026-07-23T08:05:00.000Z")
const bytes = Buffer.from("%PDF-1.4 exact PASQ")
const documentSha256 = sha256DocumentBytes(bytes)

function request(hash: unknown = documentSha256) {
  return new NextRequest("http://localhost/api/applications/app-1/pasq/acknowledge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ documentSha256: hash }),
  })
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    clientId: "client-1",
    // The ceremony window: NCA s.92(1) puts the quotation before the AGREEMENT,
    // not before the credit decision.
    status: "APPROVED",
    agreementGeneratedAt: null,
    updatedAt: new Date("2026-07-23T08:03:00.000Z"),
    pasqGeneratedAt: generatedAt,
    pasqDocumentId: "pasq-1",
    pasqDocumentSha256: documentSha256,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.clearAllMocks()
  requireOwnerOrStaffMock.mockResolvedValue({
    type: "client",
    clientId: "client-1",
    clientEmail: "client@example.test",
  })
  applicationFindUniqueMock.mockResolvedValue(application())
  documentFindFirstMock.mockResolvedValue({ id: "pasq-1", storagePath: "/pasq/pasq-1.pdf" })
  accessFindFirstMock.mockResolvedValue({ id: "view-1", createdAt: viewedAt })
  readFileMock.mockResolvedValue(bytes)
  applicationUpdateManyMock.mockResolvedValue({ count: 1 })
  documentUpdateManyMock.mockResolvedValue({ count: 1 })
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    loanApplication: { updateMany: applicationUpdateManyMock },
    clientDocument: { updateMany: documentUpdateManyMock },
    auditLog: { create: auditCreateMock },
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("POST /api/applications/[id]/pasq/acknowledge", () => {
  it("rejects staff acknowledgement", async () => {
    requireOwnerOrStaffMock.mockResolvedValue({
      type: "staff",
      user: { id: "officer-1", email: "officer@example.test" },
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(403)
    expect(documentFindFirstMock).not.toHaveBeenCalled()
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("rejects a hash that is not the current application-bound document", async () => {
    const response = await POST(request("a".repeat(64)), context)

    expect(response.status).toBe(409)
    expect(documentFindFirstMock).not.toHaveBeenCalled()
  })

  it("requires a client view of the exact generated document first", async () => {
    accessFindFirstMock.mockResolvedValue(null)

    const response = await POST(request(), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/open and review/i)
    expect(accessFindFirstMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        documentId: "pasq-1",
        accessorType: "client",
        accessorId: "client-1",
        createdAt: { gte: generatedAt },
      }),
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    })
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("rejects tampered stored bytes", async () => {
    readFileMock.mockResolvedValue(Buffer.from("not the acknowledged PASQ"))

    const response = await POST(request(), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/integrity/i)
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("atomically records the client, exact hash, prior view, and audit", async () => {
    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(applicationUpdateManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "app-1",
        tenantId: "tenant-1",
        status: "APPROVED",
        agreementGeneratedAt: null,
        pasqDocumentId: "pasq-1",
        pasqDocumentSha256: documentSha256,
        pasqAcknowledgedAt: null,
        pasqAcknowledgedBy: null,
        pasqAcknowledgedSha256: null,
      }),
      data: {
        pasqAcknowledgedAt: now,
        pasqAcknowledgedBy: "client-1",
        pasqAcknowledgedSha256: documentSha256,
        // Pinned HERE and nowhere else. Approval runs before any quotation
        // exists and issue happens before the consumer has seen it, so writing
        // it at either point would let the column claim an acknowledgement
        // that never happened.
        approvedPasqDocumentSha256: documentSha256,
      },
    })
    // §3 L: the acknowledged state must land on the document row itself,
    // in the same transaction — and it is an acknowledgement, never a
    // signature.
    expect(documentUpdateManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "pasq-1",
        tenantId: "tenant-1",
        docType: "FORM_20_PRE_AGREEMENT",
        contentSha256: documentSha256,
        deletedAt: null,
      }),
      data: { signatureState: "acknowledged" },
    })
    const markData = documentUpdateManyMock.mock.calls[0][0].data
    expect(markData).not.toHaveProperty("signedAt")
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PASQ_ACKNOWLEDGED",
        userId: null,
        userEmail: "client@example.test",
        entityId: "app-1",
        newValue: expect.objectContaining({
          documentId: "pasq-1",
          documentSha256,
          priorViewId: "view-1",
          priorViewAt: viewedAt.toISOString(),
          actorType: "client",
          actorClientId: "client-1",
        }),
      }),
    })
  })

  it("rolls the WHOLE transaction back when the document mark cannot land", async () => {
    // An interactive transaction only rolls back on THROW. If the document
    // mark merely returned false after the application update succeeded,
    // the acknowledgement would COMMIT while the route reports 409 — so the
    // test pins that the transaction callback ABORTS, not just the status.
    documentUpdateManyMock.mockResolvedValueOnce({ count: 0 })
    let transactionAborted: unknown = null
    transactionMock.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      try {
        return await callback({
          loanApplication: { updateMany: applicationUpdateManyMock },
          clientDocument: { updateMany: documentUpdateManyMock },
          auditLog: { create: auditCreateMock },
        })
      } catch (error) {
        transactionAborted = error
        throw error
      }
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(transactionAborted).toBeInstanceOf(Error)
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

    it("is idempotent only for the same client and exact hash", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({
      pasqAcknowledgedAt: now,
      pasqAcknowledgedBy: "client-1",
      pasqAcknowledgedSha256: documentSha256,
    }))

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ existing: true, documentSha256 })
    expect(documentFindFirstMock).not.toHaveBeenCalled()
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("refuses to acknowledge once the agreement has been generated", async () => {
    // The quotation must be given BEFORE the agreement is entered into. An
    // acknowledgement recorded afterwards would document the opposite order.
    applicationFindUniqueMock.mockResolvedValue(application({
      agreementGeneratedAt: new Date("2026-07-23T08:04:00.000Z"),
    }))

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already been generated/i)
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("refuses to acknowledge before approval", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({ status: "UNDER_REVIEW" }))

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/signing ceremony/i)
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("fails closed when the application changes before the acknowledgement commit", async () => {
    applicationUpdateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(auditCreateMock).not.toHaveBeenCalled()
  })
})
