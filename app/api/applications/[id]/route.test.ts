import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const findFirstMock = vi.fn()
const updateManyMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()
const prepareApplicationFieldsMock = vi.fn()
const triggerNotificationMock = vi.fn()
const auditLogCreateMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  loanApplication: {
    findUnique: (a: unknown) => findUniqueMock(a),
    findFirst: (a: unknown) => findFirstMock(a),
    updateMany: (a: unknown) => updateManyMock(a),
  },
  auditLog: { create: (a: unknown) => auditLogCreateMock(a) },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transactionMock(cb),
    loanApplication: {
      findUnique: (a: unknown) => findUniqueMock(a),
      findFirst: (a: unknown) => findFirstMock(a),
      updateMany: (a: unknown) => updateManyMock(a),
    },
  },
}))
vi.mock("@/lib/applications/prepare-application", () => ({
  prepareApplicationFields: (...a: unknown[]) => prepareApplicationFieldsMock(...a),
}))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (...a: unknown[]) => triggerNotificationMock(...a),
}))

import {
  createSubmissionAffordabilitySnapshot,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { PATCH, DELETE } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const draftForSubmission = {
  id: "app-1",
  status: "DRAFT",
  updatedAt: new Date("2026-07-18T10:00:00Z"),
  appliedAmount: 500_000,
  appliedTermDays: 30,
  productId: "p1",
  initiationFeePayment: "DEFERRED",
  creditLifeElection: "DECLINED",
  creditLifeProductId: "credit-life-1",
  creditLifeProductName: "Acme Credit Life",
  creditLifeInsurerId: "insurer-1",
  creditLifeInsurerName: "Test Life",
  creditLifeMonthlyPremiumCents: 2250,
  creditLifeDisclosureVersion: "credit-life-election-v1",
  creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
    version: "credit-life-election-v1",
    election: "DECLINED",
    principalCents: 500000,
    termDays: 30,
    monthlyPremiumCents: 2250,
    productId: "credit-life-1",
    productName: "Acme Credit Life",
    insurerId: "insurer-1",
    insurerName: "Test Life",
  }),
  creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T09:45:00Z"),
  creditLifeDisclosureAcknowledgedBy: "c1",
  affordabilityResult: null,
  client: {
    grossMonthlyIncome: 1_700_000,
    monthlyIncome: 1_500_000,
    monthlyExpenses: 800_000,
    expenseBreakdown: {
      id: "expense-1",
      updatedAt: new Date("2026-07-18T09:30:00Z"),
      housing: 400_000,
      transport: 100_000,
      food: 200_000,
      education: 0,
      insurance: 50_000,
      clothing: 0,
      entertainment: 0,
      medical: 50_000,
      other: 0,
      belowMleJustification: null,
    },
    debtObligations: [{
      id: "debt-1",
      creditProvider: "Bank A",
      accountType: "PERSONAL_LOAN",
      outstandingBalance: 500_000,
      monthlyInstalment: 50_000,
      notes: "Declared",
    }],
  },
  product: {
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    initiationFeeModel: "FLAT_PCT" as const,
    initiationFeePct: 0.15,
    initiationFeeMax: 105_000,
    monthlyServiceFee: 6_900,
  },
}

function submissionResult(capturedAt: Date) {
  const snapshot = createSubmissionAffordabilitySnapshot({
    capturedAt,
    capturedById: "u1",
    client: draftForSubmission.client,
    applicationDebts: draftForSubmission.client.debtObligations.map((debt) => ({
      sourceId: debt.id,
      provider: debt.creditProvider,
      type: debt.accountType,
      balance: debt.outstandingBalance,
      monthlyInstalment: debt.monthlyInstalment,
      notes: debt.notes,
    })),
    clientDebts: draftForSubmission.client.debtObligations,
    application: {
      appliedAmount: draftForSubmission.appliedAmount,
      appliedTermDays: draftForSubmission.appliedTermDays,
      productId: draftForSubmission.productId,
      initiationFeePayment: "DEFERRED",
    },
    product: {
      productType: "MICRO",
      ...draftForSubmission.product,
      interestModel: "REDUCING_BALANCE",
    },
  })
  return withAffordabilitySnapshot(null, snapshot)
}

const priorSubmissionResult = submissionResult(new Date("2026-07-17T10:00:00Z"))
const refreshedSubmissionResult = submissionResult(new Date("2026-07-18T10:05:00Z"))
function patchReq(body: unknown) {
  return new NextRequest("http://x/api/applications/app-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
function deleteReq() {
  return new NextRequest("http://x/api/applications/app-1", { method: "DELETE" })
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
  queryRawMock.mockResolvedValue([{ id: "app-1", clientId: "c1", productId: "p1" }])
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "CREDIT_OFFICER" } })
  updateManyMock.mockResolvedValue({ count: 1 })
  findFirstMock.mockResolvedValue(null)
  triggerNotificationMock.mockResolvedValue(undefined)
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
})

it("allows DRAFT -> SUBMITTED", async () => {
  findUniqueMock.mockResolvedValue(draftForSubmission)

  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "app-1", status: "SUBMITTED" })
  expect(queryRawMock).toHaveBeenCalledTimes(5)
  expect(queryRawMock.mock.invocationCallOrder[4]).toBeLessThan(
    findUniqueMock.mock.invocationCallOrder[0],
  )
  expect(updateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "DRAFT",
      updatedAt: draftForSubmission.updatedAt,
    },
    data: expect.objectContaining({
      status: "SUBMITTED",
      submittedAt: expect.any(Date),
      totalExistingDebt: 50_000,
      affordabilityResult: expect.objectContaining({
        submission: expect.objectContaining({
          stage: "SUBMISSION",
          inputs: expect.objectContaining({
            monthlyIncomeCents: 1_500_000,
            monthlyExpensesCents: 800_000,
          }),
        }),
      }),
    }),
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "APPLICATION_SUBMITTED_BY_STAFF",
      entity: "LoanApplication",
      entityId: "app-1",
    }),
  })
})

it("includes accepted credit-life premiums in the submission affordability decision", async () => {
  const acceptedDisclosure = {
    version: "credit-life-election-v1" as const,
    election: "ACCEPTED" as const,
    principalCents: draftForSubmission.appliedAmount,
    termDays: draftForSubmission.appliedTermDays,
    monthlyPremiumCents: draftForSubmission.creditLifeMonthlyPremiumCents,
    productId: draftForSubmission.creditLifeProductId,
    productName: draftForSubmission.creditLifeProductName,
    insurerId: draftForSubmission.creditLifeInsurerId,
    insurerName: draftForSubmission.creditLifeInsurerName,
  }
  findUniqueMock.mockResolvedValue({
    ...draftForSubmission,
    creditLifeElection: acceptedDisclosure.election,
    creditLifeDisclosureSha256:
      createCreditLifeDisclosureSha256(acceptedDisclosure),
  })

  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)

  expect(res.status).toBe(200)
  expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      affordabilityResult: expect.objectContaining({
        submission: expect.objectContaining({
          inputs: expect.objectContaining({
            creditLifePremiumCents: 2_250,
            proposedInstalmentCents: expect.any(Number),
          }),
          outcome: expect.objectContaining({
            requiredNdiCents: expect.any(Number),
          }),
        }),
      }),
    }),
  }))
  const result = updateManyMock.mock.calls[0][0].data.affordabilityResult
  expect(result.submission.inputs.proposedInstalmentCents).toBe(
    result.submission.calculator.recurringInstalmentCents + 2_250,
  )
  expect(result.submission.outcome.requiredNdiCents).toBe(
    result.submission.inputs.proposedInstalmentCents,
  )
})

it("rejects DRAFT -> SUBMITTED when Regulation 23A living expenses lack justification", async () => {
  findUniqueMock.mockResolvedValue({
    ...draftForSubmission,
    client: {
      ...draftForSubmission.client,
      monthlyExpenses: 0,
      expenseBreakdown: {
        ...draftForSubmission.client.expenseBreakdown,
        housing: 0,
        transport: 0,
        food: 0,
        insurance: 0,
        medical: 0,
      },
    },
  })

  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)
  const body = await res.json() as { affordabilitySnapshot: string }

  expect(res.status).toBe(422)
  expect(body.affordabilitySnapshot).toBe("mle_justification_missing")
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("rejects DRAFT -> SUBMITTED when itemised expenses contradict the client total", async () => {
  findUniqueMock.mockResolvedValue({
    ...draftForSubmission,
    client: {
      ...draftForSubmission.client,
      expenseBreakdown: {
        ...draftForSubmission.client.expenseBreakdown,
        housing: draftForSubmission.client.expenseBreakdown.housing + 1,
      },
    },
  })

  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)
  const body = await res.json() as { affordabilitySnapshot: string }

  expect(res.status).toBe(422)
  expect(body.affordabilitySnapshot).toBe("expense_evidence_invalid")
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("rejects a target status other than SUBMITTED with 400", async () => {
  const res = await PATCH(patchReq({ status: "APPROVED" }), ctx)
  expect(res.status).toBe(400)
  expect(findUniqueMock).not.toHaveBeenCalled()
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rejects when the application is not currently DRAFT", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", status: "SUBMITTED" })
  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)
  expect(res.status).toBe(400)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("404s when the application does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)
  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)
  expect(res.status).toBe(404)
})

it("short-circuits with the guard's response when unauthorized", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)
  expect(res.status).toBe(403)
  expect(findUniqueMock).not.toHaveBeenCalled()
})

it("409s when a concurrent write already moved the application off DRAFT (race guard)", async () => {
  findUniqueMock.mockResolvedValue(draftForSubmission)
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await PATCH(patchReq({ status: "SUBMITTED" }), ctx)

  expect(res.status).toBe(409)
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

const draftUpdateBody = {
  action: "update" as const,
  clientId: "c1",
  productId: "p1",
  appliedAmount: 500_000,
  appliedTermDays: 30,
  purpose: "Debt consolidation",
  purposeDetails: "",
  loanPurposeCategory: "DEBT_CONSOLIDATION",
  monthlyInstalment: "",
  totalInterest: "",
  totalRepayable: "",
  affordabilityFlag: "PASS",
  pasqAcknowledged: false,
  affordabilityDeclared: false,
  recklessLendingConfirmed: false,
  submitForReview: false,
}

const preparedDraftFields = {
  clientId: "c1",
  productId: "p1",
  appliedAmount: 500_000,
  appliedTermDays: 30,
  purpose: "Debt consolidation",
  loanPurposeCategory: "DEBT_CONSOLIDATION",
  agreementType: "SMALL",
  existingDebtObligations: [],
  totalExistingDebt: 0,
  netDisposableIncome: 950_000,
  affordabilityNDI: 950_000,
  affordabilityResult: { schemaVersion: 3 },
  status: "DRAFT",
  submittedAt: null,
}

it("PATCH action:update — happy path writes via updateMany pinned on DRAFT + tenantId", async () => {
  const updatedAt = new Date("2026-07-18T10:00:00Z")
  findUniqueMock.mockResolvedValue({
    id: "app-1",
    status: "DRAFT",
    updatedAt,
    affordabilityResult: priorSubmissionResult,
  })
  prepareApplicationFieldsMock.mockResolvedValue({ ok: true, fields: preparedDraftFields })

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "app-1", status: "DRAFT" })
  expect(queryRawMock).toHaveBeenCalledTimes(5)
  expect(queryRawMock.mock.invocationCallOrder[4]).toBeLessThan(
    prepareApplicationFieldsMock.mock.invocationCallOrder[0],
  )
  expect(prepareApplicationFieldsMock).toHaveBeenCalledWith(
    expect.objectContaining({ action: "update", clientId: "c1" }),
    "t1",
    "u1",
    { action: "update" },
    tx,
  )
  expect(updateManyMock).toHaveBeenCalledWith({
    where: { id: "app-1", tenantId: "t1", status: "DRAFT", updatedAt },
    data: {
      ...preparedDraftFields,
      affordabilityResult: priorSubmissionResult,
    },
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "APPLICATION_UPDATED_BY_STAFF",
      entity: "LoanApplication",
      entityId: "app-1",
    }),
  })
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("PATCH action:update — submitting a resumed draft transitions to SUBMITTED and notifies", async () => {
  findUniqueMock.mockResolvedValue({
    id: "app-1",
    status: "DRAFT",
    affordabilityResult: priorSubmissionResult,
  })
  prepareApplicationFieldsMock.mockResolvedValue({
    ok: true,
    fields: {
      ...preparedDraftFields,
      status: "SUBMITTED",
      submittedAt: new Date("2026-07-18T10:05:00Z"),
      affordabilityResult: refreshedSubmissionResult,
    },
  })

  const res = await PATCH(patchReq({ ...draftUpdateBody, submitForReview: true }), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "app-1", status: "SUBMITTED" })
  expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      affordabilityResult: expect.objectContaining({
        submission: refreshedSubmissionResult.submission,
        submissionHistory: [priorSubmissionResult.submission],
      }),
    }),
  }))
  expect(triggerNotificationMock).toHaveBeenCalledWith(
    expect.objectContaining({ event: "application_submitted", loanId: "app-1", clientId: "c1" })
  )
})

it("PATCH action:update — 400 when prepareApplicationFields reports a validation failure", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", status: "DRAFT", affordabilityResult: null })
  prepareApplicationFieldsMock.mockResolvedValue({
    ok: false,
    status: 400,
    body: { error: "Validation failed", errors: { clientId: "Pick a client (or create a new one)" } },
  })

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: "Validation failed",
    errors: { clientId: "Pick a client (or create a new one)" },
  })
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("PATCH action:update — 404 when the application does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(404)
  expect(prepareApplicationFieldsMock).not.toHaveBeenCalled()
})

it("PATCH action:update — 400 when the application is no longer DRAFT", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", status: "SUBMITTED", affordabilityResult: null })

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(400)
  expect(prepareApplicationFieldsMock).not.toHaveBeenCalled()
})

it("PATCH action:update — 409 when a concurrent write already moved the application off DRAFT (race guard)", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", status: "DRAFT", affordabilityResult: null })
  prepareApplicationFieldsMock.mockResolvedValue({ ok: true, fields: preparedDraftFields })
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(409)
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("PATCH action:update — maps a database open-tuple collision to a verified 409", async () => {
  findUniqueMock.mockResolvedValue({
    id: "app-1",
    status: "DRAFT",
    updatedAt: new Date("2026-07-18T10:00:00Z"),
    affordabilityResult: null,
  })
  prepareApplicationFieldsMock.mockResolvedValue({ ok: true, fields: preparedDraftFields })
  updateManyMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed",
    { code: "P2002", clientVersion: "5.x" },
  ))
  findFirstMock.mockResolvedValue({
    id: "app-existing",
    reference: "APP-EXISTING",
    status: "SUBMITTED",
  })

  const res = await PATCH(patchReq(draftUpdateBody), ctx)

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual(expect.objectContaining({
    existingApplicationId: "app-existing",
  }))
  expect(findFirstMock).toHaveBeenCalledWith({
    where: {
      id: { not: "app-1" },
      tenantId: "t1",
      clientId: "c1",
      productId: "p1",
      status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] },
    },
    select: { id: true, reference: true, status: true },
  })
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("DRAFT -> SUBMITTED fails closed when its mandatory audit insert fails", async () => {
  findUniqueMock.mockResolvedValue(draftForSubmission)
  auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

  await expect(PATCH(patchReq({ status: "SUBMITTED" }), ctx)).rejects.toThrow(
    "audit unavailable",
  )
  expect(updateManyMock).toHaveBeenCalledOnce()
  expect(auditLogCreateMock).toHaveBeenCalledOnce()
})

it("DELETE cancels a non-terminal application", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", reference: "APP-1", status: "SUBMITTED", loan: null })

  const res = await DELETE(deleteReq(), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "app-1", status: "CANCELLED" })
  expect(updateManyMock).toHaveBeenCalledWith({
    where: { id: "app-1", tenantId: "t1", status: { notIn: ["APPROVED", "DISBURSED", "CANCELLED"] } },
    data: { status: "CANCELLED", decisionReason: "Cancelled by staff" },
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "APPLICATION_CANCELLED",
      entityId: "app-1",
    }),
  })
})

it("DELETE fails closed when the mandatory cancellation audit insert fails", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", reference: "APP-1", status: "SUBMITTED", loan: null })
  auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

  await expect(DELETE(deleteReq(), ctx)).rejects.toThrow("audit unavailable")
  expect(updateManyMock).toHaveBeenCalledOnce()
  expect(auditLogCreateMock).toHaveBeenCalledOnce()
})

it("DELETE refuses to cancel an application with an attached loan or in APPROVED/DISBURSED status", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", reference: "APP-1", status: "APPROVED", loan: null })

  const res = await DELETE(deleteReq(), ctx)

  expect(res.status).toBe(409)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("DELETE is idempotent on an already-CANCELLED application", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", reference: "APP-1", status: "CANCELLED", loan: null })

  const res = await DELETE(deleteReq(), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "app-1", status: "CANCELLED" })
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("DELETE 404s when the application does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(404)
})

it("DELETE 409s when a concurrent write already moved the application into a terminal state (race guard)", async () => {
  findUniqueMock.mockResolvedValue({ id: "app-1", reference: "APP-1", status: "SUBMITTED", loan: null })
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await DELETE(deleteReq(), ctx)

  expect(res.status).toBe(409)
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})
