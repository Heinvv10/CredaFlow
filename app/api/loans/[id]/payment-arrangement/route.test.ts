import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const loanFindFirstMock = vi.fn()
const loanUpdateMock = vi.fn()
const arrangementFindUniqueMock = vi.fn()
const arrangementUpsertMock = vi.fn()
const auditCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
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
const request = () => new NextRequest("http://x/api/loans/loan-1/payment-arrangement", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agreedAmount: 10_000,
    frequency: "MONTHLY",
    startDate: "2026-08-01",
    endDate: "2026-10-01",
  }),
})

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "collector-1", email: "collector@example.test" } })
  queryRawMock.mockResolvedValue([])
  loanUpdateMock.mockResolvedValue({ id: "loan-1" })
  arrangementUpsertMock.mockResolvedValue({ id: "arr-1", loanId: "loan-1" })
  arrangementFindUniqueMock.mockResolvedValue(null)
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
    $queryRaw: queryRawMock,
    loan: {
      findFirst: (args: unknown) => loanFindFirstMock(args),
      update: (args: unknown) => loanUpdateMock(args),
    },
    paymentArrangement: {
      findUnique: (args: unknown) => arrangementFindUniqueMock(args),
      upsert: (args: unknown) => arrangementUpsertMock(args),
    },
    auditLog: { create: (args: unknown) => auditCreateMock(args) },
  }))
})

describe("POST payment arrangement collections guard", () => {
  it.each([
    { status: "COMPLETED", arrearsAmount: 10_000, outstandingPrincipal: 10_000, daysInArrears: 30 },
    { status: "ACTIVE", arrearsAmount: 0, outstandingPrincipal: 10_000, daysInArrears: 0 },
    { status: "DEFAULTED", arrearsAmount: 10_000, outstandingPrincipal: 0, daysInArrears: 30 },
  ])("rejects an ineligible terminal/current/zero-balance account", async (loan) => {
    loanFindFirstMock.mockResolvedValue({ id: "loan-1", collectionsStage: "NONE", ...loan })

    expect((await POST(request(), ctx)).status).toBe(422)
    expect(queryRawMock).toHaveBeenCalled()
    expect(arrangementUpsertMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("locks and rechecks the loan before creating the arrangement", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 45,
      collectionsStage: "NONE",
    })

    expect((await POST(request(), ctx)).status).toBe(200)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(loanFindFirstMock.mock.invocationCallOrder[0])
    expect(loanFindFirstMock.mock.invocationCallOrder[0]).toBeLessThan(arrangementUpsertMock.mock.invocationCallOrder[0])
    expect(loanUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ collectionsStage: "PAYMENT_ARRANGEMENT" }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "PAYMENT_ARRANGEMENT_CREATED",
        userId: "collector-1",
        userEmail: "collector@example.test",
        oldValue: { stage: "NONE" },
        newValue: expect.objectContaining({
          arrangementId: "arr-1",
          stage: "PAYMENT_ARRANGEMENT",
        }),
      }),
    }))
    expect(loanUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(auditCreateMock.mock.invocationCallOrder[0])
  })

  it.each(["ATTORNEY_REFERRED", "WRITTEN_OFF"])(
    "refuses to regress a later %s stage to PAYMENT_ARRANGEMENT",
    async (collectionsStage) => {
      loanFindFirstMock.mockResolvedValue({
        id: "loan-1",
        status: "DEFAULTED",
        arrearsAmount: 10_000,
        outstandingPrincipal: 50_000,
        daysInArrears: 95,
        collectionsStage,
      })

      const response = await POST(request(), ctx)

      expect(response.status).toBe(409)
      expect(arrangementUpsertMock).not.toHaveBeenCalled()
      expect(loanUpdateMock).not.toHaveBeenCalled()
      expect(auditCreateMock).not.toHaveBeenCalled()
    },
  )

  it("allows a same-stage arrangement update without treating it as a regression", async () => {
    loanFindFirstMock.mockResolvedValue({
      id: "loan-1",
      status: "DEFAULTED",
      arrearsAmount: 10_000,
      outstandingPrincipal: 50_000,
      daysInArrears: 95,
      collectionsStage: "PAYMENT_ARRANGEMENT",
    })
    arrangementFindUniqueMock.mockResolvedValue({
      id: "arr-1",
      agreedAmount: 9_000,
      frequency: "WEEKLY",
      status: "ACTIVE",
    })

    expect((await POST(request(), ctx)).status).toBe(200)
    expect(arrangementUpsertMock).toHaveBeenCalledOnce()
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "PAYMENT_ARRANGEMENT_UPDATED",
        oldValue: expect.objectContaining({
          stage: "PAYMENT_ARRANGEMENT",
          arrangement: expect.objectContaining({ agreedAmount: 9_000 }),
        }),
      }),
    }))
  })

  it("fails the request when the in-transaction audit evidence cannot be written", async () => {
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
    expect(arrangementUpsertMock).toHaveBeenCalledOnce()
    expect(loanUpdateMock).toHaveBeenCalledOnce()
    expect(auditCreateMock).toHaveBeenCalledOnce()
  })

  it("returns 404 under the lock when the loan does not belong to the tenant", async () => {
    loanFindFirstMock.mockResolvedValue(null)

    expect((await POST(request(), ctx)).status).toBe(404)
    expect(arrangementUpsertMock).not.toHaveBeenCalled()
  })
})
