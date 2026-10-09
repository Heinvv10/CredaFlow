import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const findUniqueMock = vi.fn()
const createMock = vi.fn()
const logAuditMock = vi.fn()
const getFscaReturnDataMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin-1", email: "admin@example.test" } }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", () => ({ logAudit: (a: unknown) => logAuditMock(a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      findFirst: (a: unknown) => findFirstMock(a),
      findUnique: (a: unknown) => findUniqueMock(a),
      create: (a: unknown) => createMock(a),
    },
  },
}))
vi.mock("@/lib/fsca-return", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fsca-return")>("@/lib/fsca-return")
  return { ...actual, getFscaReturnData: (...a: unknown[]) => getFscaReturnDataMock(...a) }
})

import { Prisma } from "@prisma/client"
import { POST } from "./route"
import { defaultQuarter } from "@/lib/compliance/quarters"
import { fscaSubmissionKey } from "@/lib/fsca-return"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const QUARTER = defaultQuarter()

function post(body: unknown) {
  return new NextRequest("https://staging.example.test/api/compliance/fsca-return", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const returnData = {
  quarter: QUARTER,
  fspNumber: ACME_LENDER.fspNumber,
  policiesInForce: { count: 4, sumAssured: 400 },
  gwp: { count: 2, total: 200 },
  newBusiness: { byType: {}, total: 2 },
  claims: {},
  lapses: { count: 1, sumAssured: 100 },
  complaints: { byStatus: {}, byOutcome: {}, total: 0 },
  ppr: { issued: 2, acknowledged: 1, ratio: 0.5 },
  advisorCommissions: { total: 50 },
  submittedAt: null,
  submittedByName: null,
}

describe("POST /api/compliance/fsca-return", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1" } })
    findFirstMock.mockResolvedValue(null)
    createMock.mockResolvedValue({ id: "rec-1", completedAt: new Date("2026-07-02T09:00:00Z") })
    getFscaReturnDataMock.mockResolvedValue(returnData)
  })

  it("freezes the filed figures rather than storing a bare submitted flag", async () => {
    // Every FSCA count is recomputed from live rows — policies lapse, claims
    // settle — so without a snapshot a filed quarter is unreconstructable.
    await POST(post({ quarter: QUARTER }))
    const stored = createMock.mock.calls[0][0].data.data
    expect(stored.quarter).toBe(QUARTER)
    expect(stored.snapshot).toMatchObject({
      quarter: QUARTER,
      fspNumber: ACME_LENDER.fspNumber,
      policiesInForce: { count: 4, sumAssured: 400 },
      ppr: { issued: 2, acknowledged: 1, ratio: 0.5 },
    })
  })

  it("reserves the quarter with a tenant-scoped unique key", async () => {
    await POST(post({ quarter: QUARTER }))
    expect(createMock.mock.calls[0][0].data.idempotencyKey)
      .toBe(fscaSubmissionKey("tenant-1", QUARTER))
    expect(fscaSubmissionKey("t-a", QUARTER)).not.toBe(fscaSubmissionKey("t-b", QUARTER))
  })

  it("does not collide with the NCR return's keys in the same unique column", async () => {
    const { ncrSubmissionKey } = await import("@/lib/compliance/ncr-return")
    expect(fscaSubmissionKey("tenant-1", QUARTER)).not.toBe(ncrSubmissionKey("tenant-1", QUARTER))
  })

  it("returns the winner on a concurrent double-submit instead of 500ing", async () => {
    // This route has no try/catch of its own and withTenantContext does not
    // catch, so adding a unique key without handling P2002 would turn a
    // double-submit that previously returned 200 into an unhandled 500.
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    )
    findUniqueMock.mockResolvedValue({ id: "rec-winner", completedAt: new Date("2026-07-01T00:00:00Z") })

    const res = await POST(post({ quarter: QUARTER }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ id: "rec-winner", alreadySubmitted: true })
    expect(findUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: fscaSubmissionKey("tenant-1", QUARTER) },
    }))
  })

  it("writes no second audit row for the loser of the race", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    )
    findUniqueMock.mockResolvedValue({ id: "rec-winner", completedAt: new Date() })
    await POST(post({ quarter: QUARTER }))
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("audits a real submission", async () => {
    await POST(post({ quarter: QUARTER }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      action: "FSCA_RETURN_SUBMITTED",
      entityId: "rec-1",
      newValue: { quarter: QUARTER },
    }))
  })

  it("short-circuits an already-submitted quarter without recomputing", async () => {
    findFirstMock.mockResolvedValue({ id: "rec-old", completedAt: new Date("2026-07-01T00:00:00Z") })
    const res = await POST(post({ quarter: QUARTER }))
    expect((await res.json()).alreadySubmitted).toBe(true)
    expect(createMock).not.toHaveBeenCalled()
    expect(getFscaReturnDataMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed or out-of-range quarter", async () => {
    for (const q of ["2026-Q9", "1999-Q1", "", "nonsense"]) {
      const res = await POST(post({ quarter: q }))
      expect(res.status).toBe(400)
    }
    expect(createMock).not.toHaveBeenCalled()
  })

  it("propagates the role guard's rejection", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await POST(post({ quarter: QUARTER }))
    expect(res.status).toBe(403)
    expect(createMock).not.toHaveBeenCalled()
  })
})
