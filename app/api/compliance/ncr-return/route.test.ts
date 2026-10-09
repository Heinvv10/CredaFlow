import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const createMock = vi.fn()
const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const logAuditMock = vi.fn()
const getNcrReturnDataMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin-1", email: "admin@example.test" } }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", () => ({ logAudit: (a: unknown) => logAuditMock(a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      findFirst: (a: unknown) => findFirstMock(a),
      findUnique: (a: unknown) => findUniqueMock(a),
      create: (a: unknown) => createMock(a),
      updateMany: (a: unknown) => updateManyMock(a),
    },
  },
}))
vi.mock("@/lib/compliance/ncr-return", async () => {
  const actual = await vi.importActual<typeof import("@/lib/compliance/ncr-return")>(
    "@/lib/compliance/ncr-return",
  )
  return { ...actual, getNcrReturnData: (...a: unknown[]) => getNcrReturnDataMock(...a) }
})

import { Prisma } from "@prisma/client"
import * as route from "./route"
import { listSelectableQuarters, defaultQuarter } from "@/lib/compliance/quarters"
import { ncrSubmissionKey } from "@/lib/compliance/ncr-return"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const QUARTER = defaultQuarter()

function post(body: unknown) {
  return new NextRequest("https://staging.example.test/api/compliance/ncr-return", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const returnData = {
  quarter: QUARTER,
  periodStart: new Date("2026-04-01T00:00:00Z"),
  periodEnd: new Date("2026-06-30T23:59:59Z"),
  quarterOpen: false,
  ncrNumber: ACME_LENDER.ncrNumber,
  collectibleBook: { count: 20, value: 100000 },
  lines: [
    { key: "par30", label: "PAR30", count: 6, value: 400, basis: "POSITION" as const, percentOfBook: 40 },
  ],
  submittedAt: null,
  submittedByName: null,
  positionIsStale: false,
}

describe("POST /api/compliance/ncr-return", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1" } })
    findFirstMock.mockResolvedValue(null)
    createMock.mockResolvedValue({ id: "rec-1", completedAt: new Date("2026-07-02T09:00:00Z") })
    updateManyMock.mockResolvedValue({ count: 0 })
    getNcrReturnDataMock.mockResolvedValue(returnData)
  })

  it("ignores a caller-supplied record id entirely", async () => {
    // The predecessor took `{ id }` and updated by it; a Section 129 row could
    // be flipped to SUBMITTED if the type predicate were ever dropped. The
    // quarter-keyed contract removes the parameter, so the id below must reach
    // no query at all.
    await route.POST(post({ quarter: QUARTER, id: "section129-record-id" }))

    const everyQuery = [
      ...findFirstMock.mock.calls,
      ...createMock.mock.calls,
      ...updateManyMock.mock.calls,
    ]
    expect(everyQuery.length).toBeGreaterThan(0)
    expect(JSON.stringify(everyQuery)).not.toContain("section129-record-id")

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "NCR_QUARTERLY_RETURN", status: "SUBMITTED" }),
    }))
    expect(createMock.mock.calls[0][0].data).not.toHaveProperty("id")
  })

  it("resolves a lingering PENDING row for the quarter, scoped to NCR returns only", async () => {
    // Without this the PENDING row counts as an open statutory obligation
    // forever: submission now creates its own row rather than updating one.
    await route.POST(post({ quarter: QUARTER }))
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        type: "NCR_QUARTERLY_RETURN",
        status: "PENDING",
        data: { path: ["quarter"], equals: QUARTER },
      },
      data: { status: "SUBMITTED", completedAt: expect.anything() },
    })
  })

  it("never issues an update that could reach another record type", async () => {
    await route.POST(post({ quarter: QUARTER }))
    for (const [args] of updateManyMock.mock.calls) {
      expect(args.where.type).toBe("NCR_QUARTERLY_RETURN")
      expect(args.where.tenantId).toBe("tenant-1")
      expect(args.where).not.toHaveProperty("id")
    }
  })

  it("has no PATCH handler", () => {
    expect((route as Record<string, unknown>).PATCH).toBeUndefined()
  })

  it("rejects a malformed quarter", async () => {
    const res = await route.POST(post({ quarter: "2026-Q9" }))
    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("rejects a quarter outside the selectable window", async () => {
    const res = await route.POST(post({ quarter: "2019-Q1" }))
    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("rejects a missing quarter rather than defaulting to one", async () => {
    const res = await route.POST(post({}))
    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("accepts every selectable quarter", async () => {
    for (const q of listSelectableQuarters()) {
      const res = await route.POST(post({ quarter: q }))
      expect(res.status).toBe(200)
    }
  })

  it("freezes the filed figures into the record", async () => {
    await route.POST(post({ quarter: QUARTER }))
    const stored = createMock.mock.calls[0][0].data.data
    expect(stored.quarter).toBe(QUARTER)
    expect(stored.submittedByUserId).toBe("admin-1")
    expect(stored.snapshot.lines[0]).toMatchObject({ key: "par30", count: 6, value: 400 })
    expect(stored.snapshot.collectibleBook).toEqual({ count: 20, value: 100000 })
  })

  it("writes an audit row for the submission", async () => {
    await route.POST(post({ quarter: QUARTER }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      userId: "admin-1",
      action: "NCR_RETURN_SUBMITTED",
      entity: "ComplianceRecord",
      entityId: "rec-1",
      newValue: { quarter: QUARTER },
    }))
  })

  it("is idempotent per quarter and does not write a second record", async () => {
    findFirstMock.mockResolvedValue({ id: "rec-existing", completedAt: new Date("2026-07-01T00:00:00Z") })
    const res = await route.POST(post({ quarter: QUARTER }))
    const body = await res.json()
    expect(body).toMatchObject({ id: "rec-existing", alreadySubmitted: true })
    expect(createMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("scopes the duplicate check to the tenant and the requested quarter", async () => {
    await route.POST(post({ quarter: QUARTER }))
    expect(findFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        type: "NCR_QUARTERLY_RETURN",
        status: "SUBMITTED",
        data: { path: ["quarter"], equals: QUARTER },
      }),
    }))
  })

  it("propagates the role guard's rejection", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: new Response(null, { status: 403 }),
    })
    const res = await route.POST(post({ quarter: QUARTER }))
    expect(res.status).toBe(403)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("returns 500 rather than a false success when the write fails", async () => {
    createMock.mockRejectedValue(new Error("db down"))
    const res = await route.POST(post({ quarter: QUARTER }))
    expect(res.status).toBe(500)
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/compliance/ncr-return", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "staff-1" } })
    getNcrReturnDataMock.mockResolvedValue(returnData)
  })

  function get(query = "") {
    return new NextRequest(
      `https://staging.example.test/api/compliance/ncr-return${query}`,
    )
  }

  it("serves the same source the page renders, for the requested quarter", async () => {
    const q = listSelectableQuarters()[2]
    const res = await route.GET(get(`?quarter=${q}`))
    expect(res.status).toBe(200)
    expect(getNcrReturnDataMock).toHaveBeenCalledWith("tenant-1", q)
  })

  it("coerces an out-of-range quarter to the default instead of erroring", async () => {
    const res = await route.GET(get("?quarter=1999-Q1"))
    expect(res.status).toBe(200)
    expect(getNcrReturnDataMock).toHaveBeenCalledWith("tenant-1", defaultQuarter())
  })
})

describe("concurrent submission of the same quarter", () => {
  const KEY = ncrSubmissionKey("tenant-1", QUARTER)

  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1" } })
    findFirstMock.mockResolvedValue(null)
    getNcrReturnDataMock.mockResolvedValue(returnData)
  })

  it("reserves the quarter with a unique key so the database refuses a duplicate", async () => {
    createMock.mockResolvedValue({ id: "rec-1", completedAt: new Date() })
    await route.POST(post({ quarter: QUARTER }))
    expect(createMock.mock.calls[0][0].data.idempotencyKey).toBe(KEY)
  })

  it("scopes the reservation key to the tenant, since the constraint is global", () => {
    expect(ncrSubmissionKey("tenant-a", QUARTER))
      .not.toBe(ncrSubmissionKey("tenant-b", QUARTER))
    expect(KEY).toContain("tenant-1")
    expect(KEY).toContain(QUARTER)
  })

  it("returns the winning record instead of 500ing when it loses the race", async () => {
    // Both requests pass the findFirst check; the loser's INSERT hits the
    // unique index.
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    )
    findUniqueMock.mockResolvedValue({ id: "rec-winner", completedAt: new Date("2026-07-02T09:00:00Z") })

    const res = await route.POST(post({ quarter: QUARTER }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ id: "rec-winner", alreadySubmitted: true })
    expect(findUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: KEY },
    }))
  })

  it("writes no second audit row for the losing request", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    )
    findUniqueMock.mockResolvedValue({ id: "rec-winner", completedAt: new Date() })
    await route.POST(post({ quarter: QUARTER }))
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("surfaces a non-uniqueness write failure as 500 rather than a false success", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("boom", { code: "P2003", clientVersion: "5" }),
    )
    const res = await route.POST(post({ quarter: QUARTER }))
    expect(res.status).toBe(500)
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
