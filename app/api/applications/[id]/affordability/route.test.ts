import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const auditLogCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()

// The client's own loans with this lender: none here (the real-DB behaviour is
// lib/affordability/own-lender-debt.integration.test.ts). The list merge stays real.
const ownLenderLoansMock = vi.hoisted(() => ({ loans: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/affordability/own-lender-debt-load", async (importOriginal) => {
  const { withOwnLenderDebts } = await import("@/lib/affordability/own-lender-debt")
  const { readAffordabilityDebtInputs } = await import("@/lib/affordability/snapshot")
  const own = () => ({ lenderNames: ["Acme Lending"], loans: ownLenderLoansMock.loans as never[] })
  return {
    ...(await importOriginal<typeof import("@/lib/affordability/own-lender-debt-load")>()),
    loadOwnLenderDebts: async () => own(),
    liveOwnAwareDebtInputs: async (_db: unknown, _t: string, _id: string, source: { existingDebtObligations: unknown; client: { debtObligations: never[] } }) => ({
      application: withOwnLenderDebts(readAffordabilityDebtInputs(source.existingDebtObligations), own()),
      client: withOwnLenderDebts(source.client.debtObligations, own()),
    }),
  }
})
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole: () => requireApiRoleMock(),
  // The real permission check (the client-safe twin of auth-guards' canDo).
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => transactionMock(callback),
  },
}))
vi.mock("@/lib/loan-calculator", () => ({
  calculateLoan: () => ({
    principal: 500_000,
    totalInterest: 30_000,
    initiationFee: 75_000,
    serviceFees: 20_700,
    totalRepayable: 625_700,
    disbursementAmount: 500_000,
    monthlyInstalment: 180_000,
    schedule: [{
      installmentNo: 1,
      dueDate: new Date("2026-08-18T12:00:00.000Z"),
      principalDue: 160_000,
      interestDue: 13_100,
      feesDue: 81_900,
      totalDue: 255_000,
      openingBalance: 500_000,
      closingBalance: 340_000,
    }],
  }),
}))

import { PATCH } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const request = (body: unknown = { existingDebtObligations: [] }) => new NextRequest("http://localhost/api/applications/app-1/affordability", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const application = {
  id: "app-1",
  status: "UNDER_REVIEW",
  updatedAt: new Date("2026-07-18T12:00:00Z"),
  productId: "product-1",
  appliedAmount: 500_000,
  appliedTermDays: 90,
  initiationFeePayment: "DEFERRED",
  affordabilityResult: {
    schemaVersion: 1,
    submission: { stage: "SUBMISSION", capturedAt: "2026-07-18T10:00:00.000Z" },
  },
  client: {
    grossMonthlyIncome: 1_700_000,
    monthlyIncome: 1_500_000,
    monthlyExpenses: 800_000,
    expenseBreakdown: {
      id: "expense-1",
      updatedAt: new Date("2026-07-18T11:00:00Z"),
      housing: 300_000,
      transport: 100_000,
      food: 200_000,
      education: 0,
      insurance: 50_000,
      clothing: 25_000,
      entertainment: 25_000,
      medical: 50_000,
      other: 50_000,
      belowMleJustification: null,
    },
    debtObligations: [],
  },
  product: {
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    initiationFeePct: 0.15,
    initiationFeeMax: 105_000,
    monthlyServiceFee: 6_900,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "officer-1", email: "officer@example.test", role: "CREDIT_OFFICER" },
  })
  findUniqueMock.mockResolvedValue(application)
  updateManyMock.mockResolvedValue({ count: 1 })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  queryRawMock.mockResolvedValue([{
    id: "app-1",
    clientId: "client-1",
    productId: "product-1",
    lockResult: "",
  }])
  transactionMock.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: queryRawMock,
    loanApplication: {
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
    auditLog: { create: auditLogCreateMock },
  }))
})

describe("PATCH /api/applications/[id]/affordability", () => {
  it("writes a versioned application snapshot without discarding submission evidence", async () => {
    const response = await PATCH(request(), context)

    expect(response.status).toBe(200)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "app-1",
        tenantId: "tenant-1",
        status: "UNDER_REVIEW",
        updatedAt: application.updatedAt,
      },
      data: expect.objectContaining({
        affordabilityResult: expect.objectContaining({
          schemaVersion: 3,
          legacy: application.affordabilityResult,
          assessment: expect.objectContaining({
            stage: "ASSESSMENT",
            capturedById: "officer-1",
            inputs: expect.objectContaining({
              monthlyIncomeCents: 1_500_000,
              monthlyExpensesCents: 800_000,
            }),
            expenses: expect.objectContaining({
              source: "CLIENT_BREAKDOWN",
              sourceId: "expense-1",
              grossMonthlyIncomeCents: 1_700_000,
              breakdownTotalCents: 800_000,
              fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            calculator: expect.objectContaining({
              version: "loan-calculator-v3",
              contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          }),
        }),
      }),
    })
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-application:tenant-1:app-1"],
    }))
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueMock.mock.invocationCallOrder[0],
    )
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AFFORDABILITY_ASSESSED",
        entityId: "app-1",
        userId: "officer-1",
        userEmail: "officer@example.test",
      }),
    })
  })

  it("refuses to rewrite affordability evidence after approval", async () => {
    findUniqueMock.mockResolvedValue({ ...application, status: "APPROVED" })

    const response = await PATCH(request(), context)

    expect(response.status).toBe(409)
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it.each([
    [-500_000, "negative"],
    ["garbage", "non-numeric"],
    [null, "null"],
    [false, "boolean"],
    [1.5, "fractional"],
    [2_147_483_648, "outside the database range"],
  ])("rejects %s monthly debt evidence instead of normalising it to zero (%s)", async (monthlyInstalment, _description) => {
    const response = await PATCH(request({
      existingDebtObligations: [{
        creditor: "Synthetic Bank",
        type: "PERSONAL_LOAN",
        balance: 1_000_000,
        monthlyInstalment,
      }],
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Invalid affordability debt evidence",
      errors: {
        "existingDebtObligations.0.monthlyInstalment":
          "existingDebtObligations.0.monthlyInstalment must be a non-negative integer amount in cents",
      },
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects an aggregate monthly debt outside the database range before reading the application", async () => {
    const response = await PATCH(request({
      existingDebtObligations: [
        {
          creditor: "Synthetic Bank A",
          type: "PERSONAL_LOAN",
          balance: 0,
          monthlyInstalment: 1_500_000_000,
        },
        {
          creditor: "Synthetic Bank B",
          type: "PERSONAL_LOAN",
          balance: 0,
          monthlyInstalment: 1_500_000_000,
        },
      ],
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Invalid affordability debt evidence",
      errors: {
        "existingDebtObligations.totalMonthlyInstalments":
          "existingDebtObligations.totalMonthlyInstalments must be a non-negative integer amount in cents",
      },
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      { creditor: "", type: "PERSONAL_LOAN", balance: 0, monthlyInstalment: 0 },
      "existingDebtObligations.0.provider",
      "existingDebtObligations.0.provider must identify a credit provider",
    ],
    [
      { creditor: "Synthetic Bank", type: "", balance: 0, monthlyInstalment: 0 },
      "existingDebtObligations.0.type",
      "existingDebtObligations.0.type must identify an account type",
    ],
  ])("rejects incomplete debt identity before immutable capture", async (debt, field, message) => {
    const response = await PATCH(request({ existingDebtObligations: [debt] }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Invalid affordability debt evidence",
      errors: { [field]: message },
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects duplicate source identifiers before immutable capture", async () => {
    const response = await PATCH(request({
      existingDebtObligations: [
        {
          sourceId: "debt-1",
          creditor: "Synthetic Bank A",
          type: "PERSONAL_LOAN",
          balance: 0,
          monthlyInstalment: 10_000,
        },
        {
          sourceId: "debt-1",
          creditor: "Synthetic Bank B",
          type: "CREDIT_CARD",
          balance: 0,
          monthlyInstalment: 20_000,
        },
      ],
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Invalid affordability debt evidence",
      errors: {
        "existingDebtObligations.1.sourceId":
          "existingDebtObligations.1.sourceId must be unique within the debt declaration",
      },
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("refuses a declared row carrying the lender-only own-loan sourceId", async () => {
    const response = await PATCH(request({
      existingDebtObligations: [
        { sourceId: "own-loan:loan-1", creditor: "Acme Lending", type: "PERSONAL_LOAN", balance: 0, monthlyInstalment: 100 },
      ],
    }), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain("counted automatically")
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed debt row as validation, not a server error", async () => {
    const response = await PATCH(request({ existingDebtObligations: [null] }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Invalid affordability debt evidence",
      errors: {
        "existingDebtObligations.0": "existingDebtObligations.0 must be an object",
      },
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("captures the client and product values re-read under the evidence locks", async () => {
    findUniqueMock.mockResolvedValue({
      ...application,
      client: {
        ...application.client,
        monthlyExpenses: 900_000,
        expenseBreakdown: {
          ...application.client.expenseBreakdown,
          housing: 400_000,
        },
      },
      product: {
        ...application.product,
        interestRatePm: 0.04,
      },
    })

    const response = await PATCH(request(), context)

    expect(response.status).toBe(200)
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        affordabilityResult: expect.objectContaining({
          assessment: expect.objectContaining({
            inputs: expect.objectContaining({
              monthlyExpensesCents: 900_000,
              interestRatePm: 0.04,
            }),
          }),
        }),
      }),
    }))
  })

  it("returns conflict without an audit when the locked application write loses its race", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    const response = await PATCH(request(), context)

    expect(response.status).toBe(409)
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("fails the request so the transaction rolls back when the mandatory audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit unavailable"))

    const response = await PATCH(request(), context)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Failed to save affordability" })
    expect(updateManyMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })
})
