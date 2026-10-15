import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  tenantConfigFind: vi.fn(),
  clientFind: vi.fn(),
  clientUpdate: vi.fn(),
  documentFindMany: vi.fn(),
  documentFindFirst: vi.fn(),
  complianceCreate: vi.fn(),
}))

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  tenantConfig: { findUnique: (...args: unknown[]) => h.tenantConfigFind(...args) },
  client: {
    findUnique: (...args: unknown[]) => h.clientFind(...args),
    update: (...args: unknown[]) => h.clientUpdate(...args),
  },
  clientDocument: {
    findMany: (...args: unknown[]) => h.documentFindMany(...args),
    findFirst: (...args: unknown[]) => h.documentFindFirst(...args),
  },
  complianceRecord: { create: (...args: unknown[]) => h.complianceCreate(...args) },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => h.requireRole(...args) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => Promise<unknown>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/affordability/evidence-locks", () => ({ lockAffordabilityClientEvidence: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) },
}))

import { POST } from "./route"

const params = { params: Promise.resolve({ id: "client-1" }) }
const request = () => new NextRequest("http://localhost/api/clients/client-1/kyc-in-person-verification", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    method: "IN_PERSON_BRANCH",
    note: "Synthetic in-person verification note is complete.",
  }),
})

const verified = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map((docType) => ({
  id: `doc-${docType}`, docType, verified: true, contentSha256: "a".repeat(64),
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  verificationRejectedAt: null, verificationRejectedById: null,
}))

const replacement = {
  id: "id-replacement", docType: "ID_COPY", verified: false, contentSha256: "b".repeat(64),
  createdAt: new Date("2026-07-02T00:00:00.000Z"),
  verificationRejectedAt: null as Date | null, verificationRejectedById: null as string | null,
}

/** The core-document read is the only findMany filtered by docType. */
function coreDocumentsAre(documents: unknown[]) {
  h.documentFindMany.mockImplementation(async (args: { where: { docType?: unknown } }) =>
    args.where.docType !== undefined ? documents : [])
}

describe("POST /api/clients/[id]/kyc-in-person-verification with a replacement ID copy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: true },
    })
    h.tenantConfigFind.mockResolvedValue({
      kycOverrideEnabled: true, kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false, requireStaffTotp: true,
    })
    h.clientFind.mockResolvedValue({
      id: "client-1", idNumber: "9001010000088", firstName: "Synthetic", lastName: "Client",
      dateOfBirth: new Date("1990-01-01T00:00:00Z"), kycStatus: "PENDING",
      kycManualRejectionActive: false,
    })
    h.documentFindFirst.mockResolvedValue(null)
  })

  it("refuses while the replacement awaits review, writing nothing", async () => {
    coreDocumentsAre([...verified, replacement])

    const response = await POST(request(), params)

    expect(response.status).toBe(422)
    expect((await response.json()).missingDocs).toEqual(["ID_COPY"])
    expect(h.complianceCreate).not.toHaveBeenCalled()
    expect(h.clientUpdate).not.toHaveBeenCalled()
  })

  it("does not hold the client back for a replacement a reviewer has refused", async () => {
    coreDocumentsAre([
      ...verified,
      { ...replacement, verificationRejectedAt: new Date("2026-07-03T00:00:00.000Z"), verificationRejectedById: "officer-1" },
    ])

    const response = await POST(request(), params)

    expect(response.status).not.toBe(422)
  })
})
