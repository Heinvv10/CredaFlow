import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const loanFindFirstMock = vi.fn()
const loanUpdateMock = vi.fn()
const referralFindUniqueMock = vi.fn()
const referralUpsertMock = vi.fn()
const complianceFindFirstMock = vi.fn()
const auditCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
  // act_on_collections itself is proved with the real guards in app/api/collections-scope-rbac.test.ts.
  canDo: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "loan-1" }) }
const request = () => new NextRequest("http://x/api/loans/loan-1/attorney-referral", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ firmName: "Test Attorneys", referralDate: "2026-07-19" }),
})

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "collector-1", email: "collector@example.test" } })
  queryRawMock.mockResolvedValue([])
  loanUpdateMock.mockResolvedValue({ id: "loan-1" })
  referralUpsertMock.mockResolvedValue({ id: "ref-1", loanId: "loan-1" })
  referralFindUniqueMock.mockResolvedValue(null)
  complianceFindFirstMock.mockResolvedValue({ id: "notice-1", completedAt: new Date("2026-07-19T08:00:00.000Z") })
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
    $queryRaw: queryRawMock,
    loan: {
      findFirst: (args: unknown) => loanFindFirstMock(args),
      update: (args: unknown) => loanUpdateMock(args),
    },
    attorneyReferral: {
      findUnique: (args: unknown) => referralFindUniqueMock(args),
      upsert: (args: unknown) => referralUpsertMock(args),
    },
    complianceRecord: { findFirst: (args: unknown) => complianceFindFirstMock(args) },
    auditLog: { create: (args: unknown) => auditCreateMock(args) },
  }))
})

describe("POST attorney referral collections guard", () => {
  it.each([
    { status: "COMPLETED", arrearsAmount: 10_000, outstandingPrincipal: 10_000, daysInArrears: 30 },
    { status: "ACTIVE", arrearsAmount: 0, outstandingPrincipal: 10_000, daysInArrears: 0 },
    { status: "CANCELLED", arrearsAmount: 10_000, outstandingPrincipal: 10_000, daysInArrears: 30 },
  ])("rejects an ineligible terminal/current account", async (loan) => {
    loanFindFirstMock.mockResolvedValue({ id: "loan-1", collectionsStage: "SECTION_129_SENT", ...loan })

    expect((await POST(request(), ctx)).status).toBe(422)
    expect(queryRawMock).toHaveBeenCalled()
    expect(referralUpsertMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("locks and rechecks the loan before creating the referral", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "SECTION_129_SENT",
    })

    expect((await POST(request(), ctx)).status).toBe(200)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(loanFindFirstMock.mock.invocationCallOrder[0])
    expect(loanFindFirstMock.mock.invocationCallOrder[0]).toBeLessThan(referralUpsertMock.mock.invocationCallOrder[0])
    expect(loanUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ collectionsStage: "ATTORNEY_REFERRED" }),
    }))
    expect(complianceFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: "SECTION_129_NOTICE",
        referenceId: "loan-1",
        status: "COMPLETED",
        data: { path: ["lifecycle"], equals: "ISSUED" },
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "ATTORNEY_REFERRAL_CREATED",
        oldValue: { stage: "SECTION_129_SENT" },
        newValue: expect.objectContaining({
          referralId: "ref-1",
          issuedNoticeId: "notice-1",
          legalScope: "PRE_ENFORCEMENT_REVIEW_ONLY",
        }),
      }),
    }))
    expect(loanUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(auditCreateMock.mock.invocationCallOrder[0])
  })

  it("blocks referral before the Section 129 collections stage", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "FORMAL_REMINDER",
    })

    const response = await POST(request(), ctx)

    expect(response.status).toBe(422)
    expect(complianceFindFirstMock).not.toHaveBeenCalled()
    expect(referralUpsertMock).not.toHaveBeenCalled()
  })

  it("blocks referral when the stage lacks a corroborating completed ISSUED notice", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "SECTION_129_SENT",
    })
    complianceFindFirstMock.mockResolvedValue(null)

    const response = await POST(request(), ctx)

    expect(response.status).toBe(422)
    expect(referralUpsertMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses to regress WRITTEN_OFF to ATTORNEY_REFERRED", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "WRITTEN_OFF",
    })

    const response = await POST(request(), ctx)

    expect(response.status).toBe(409)
    expect(complianceFindFirstMock).not.toHaveBeenCalled()
    expect(referralUpsertMock).not.toHaveBeenCalled()
  })

  it("allows same-stage referral metadata to be updated without rewriting the stage timestamp", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "ATTORNEY_REFERRED",
    })
    referralFindUniqueMock.mockResolvedValue({
      id: "ref-1",
      firmName: "Old Firm",
      matterNumber: "OLD-1",
    })

    expect((await POST(request(), ctx)).status).toBe(200)
    expect(referralUpsertMock).toHaveBeenCalledOnce()
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "ATTORNEY_REFERRAL_UPDATED",
        oldValue: expect.objectContaining({
          stage: "ATTORNEY_REFERRED",
          referral: expect.objectContaining({ firmName: "Old Firm" }),
        }),
      }),
    }))
  })

  it("fails the request when atomic referral audit evidence cannot be written", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "SECTION_129_SENT",
    })
    auditCreateMock.mockRejectedValue(new Error("audit unavailable"))

    const response = await POST(request(), ctx)

    expect(response.status).toBe(500)
    expect(referralUpsertMock).toHaveBeenCalledOnce()
    expect(loanUpdateMock).toHaveBeenCalledOnce()
    expect(auditCreateMock).toHaveBeenCalledOnce()
  })

  it("returns 404 under the lock when the loan does not belong to the tenant", async () => {
    loanFindFirstMock.mockResolvedValue(null)

    expect((await POST(request(), ctx)).status).toBe(404)
    expect(referralUpsertMock).not.toHaveBeenCalled()
  })
})
