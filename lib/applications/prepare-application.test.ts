// Mocks must be hoisted BEFORE the SUT import (pattern: lib/avs.test.ts)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loanProductFindManyMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const loanFindFirstMock = vi.fn()
const insuranceProductFindFirstMock = vi.fn()
const queryRawMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: (a: unknown) => queryRawMock(a),
    loanProduct: { findMany: (a: unknown) => loanProductFindManyMock(a) },
    insuranceProduct: { findFirst: (a: unknown) => insuranceProductFindFirstMock(a) },
    client: { findUnique: (a: unknown) => clientFindUniqueMock(a) },
    loan: { findFirst: (a: unknown) => loanFindFirstMock(a) },
  },
}))

import { prepareApplicationFields, type PrepareApplicationInput } from "./prepare-application"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const PRODUCT_ROW = {
  id: "p1",
  name: "Personal Loan",
  code: "PERSONAL",
  minAmount: 100_000, // R1000
  maxAmount: 5_000_000, // R50000
  minTermDays: 7,
  maxTermDays: 90,
  interestRatePm: 0.05,
  interestModel: "REDUCING_BALANCE",
  initiationFeePct: 0.1,
  initiationFeeMax: 100_000,
  monthlyServiceFee: 6900,
}

const CLIENT_ROW = {
  id: "c1",
  grossMonthlyIncome: 2_200_000,
  monthlyIncome: 2_000_000, // R20000 in cents
  monthlyExpenses: 1_000_000, // R10000 in cents
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-18T10:00:00Z"),
    housing: 400_000,
    transport: 150_000,
    food: 250_000,
    education: 0,
    insurance: 50_000,
    clothing: 50_000,
    entertainment: 0,
    medical: 50_000,
    other: 50_000,
    belowMleJustification: null,
  },
  debtObligations: [
    {
      id: "debt-1",
      creditProvider: "Bank X",
      accountType: "PERSONAL_LOAN",
      outstandingBalance: 500_000,
      monthlyInstalment: 50_000,
      notes: "Declared debt",
    },
  ],
}

const CREDIT_LIFE_PRODUCT = {
  id: "credit-life-1",
  name: "Acme Credit Life",
  insurerId: "insurer-1",
  insurer: {
    id: "insurer-1",
    tenantId: "t1",
    active: true,
    name: "Test Life",
  },
}
const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED

function validInput(overrides: Partial<PrepareApplicationInput> = {}): PrepareApplicationInput {
  return {
    clientId: "c1",
    productId: "p1",
    appliedAmount: 500_000, // R5000 cents
    appliedTermDays: 30,
    purpose: "Debt consolidation",
    purposeDetails: "",
    loanPurposeCategory: "DEBT_CONSOLIDATION",
    monthlyInstalment: "",
    firstInstalment: "",
    totalInterest: "",
    initiationFee: "",
    serviceFees: "",
    totalRepayable: "",
    affordabilityFlag: "PASS",
    creditLifeElection: "DECLINED",
    creditLifeDisclosureAcknowledged: true,
    creditLifeProductId: CREDIT_LIFE_PRODUCT.id,
    creditLifeProductName: CREDIT_LIFE_PRODUCT.name,
    creditLifeInsurerId: CREDIT_LIFE_PRODUCT.insurerId,
    creditLifeInsurerName: CREDIT_LIFE_PRODUCT.insurer.name,
    creditLifeMonthlyPremiumCents: 2250,
    creditLifeDisclosureVersion: "credit-life-election-v1",
    pasqAcknowledged: false,
    affordabilityDeclared: false,
    recklessLendingConfirmed: false,
    submitForReview: false,
    ...overrides,
  }
}

beforeEach(() => {
  delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  vi.clearAllMocks()
  loanProductFindManyMock.mockResolvedValue([PRODUCT_ROW])
  clientFindUniqueMock.mockResolvedValue(CLIENT_ROW)
  loanFindFirstMock.mockResolvedValue(null)
  queryRawMock.mockResolvedValue([{ id: CREDIT_LIFE_PRODUCT.id }])
  insuranceProductFindFirstMock.mockResolvedValue(CREDIT_LIFE_PRODUCT)
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
      ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
})

describe("prepareApplicationFields — validation failure", () => {
  it("returns 400 with field errors and never reaches the client/loan lookups", async () => {
    const result = await prepareApplicationFields(
      validInput({ clientId: "" }),
      "t1",
      "u1",
      { action: "create" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(400)
    expect(result.body.errors?.clientId).toBeTruthy()
    expect(clientFindUniqueMock).not.toHaveBeenCalled()
    expect(loanFindFirstMock).not.toHaveBeenCalled()
  })
})

describe("prepareApplicationFields — consumer products only", () => {
  it("validates against active consumer products: an asset-finance product is never offered (Fair Score E4)", async () => {
    await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(loanProductFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", active: true, productType: { not: "ASSET_FINANCE" } },
    }))
  })
})

describe("prepareApplicationFields — client lookup", () => {
  it("returns 404 when the client does not exist in the tenant", async () => {
    clientFindUniqueMock.mockResolvedValue(null)
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(404)
    expect(result.body.error).toBe("Client not found")
    expect(loanFindFirstMock).not.toHaveBeenCalled()
  })
})

describe("prepareApplicationFields — defaulted-client block", () => {
  it("returns 422 with the create-specific message on the create path", async () => {
    loanFindFirstMock.mockResolvedValue({ id: "loan1" })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/^Cannot create application:/)
  })

  it("returns 422 with the update-specific message on the update path", async () => {
    loanFindFirstMock.mockResolvedValue({ id: "loan1" })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "update" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/^Cannot update application:/)
  })
})

describe("prepareApplicationFields — deceased and blacklisted clients cannot originate", () => {
  // The staff picker already omits these clients from its dropdown, but the
  // dropdown is not the gate: POST /api/applications accepts any clientId. A
  // filtered <select> is a convenience, not authorization.
  it("refuses to open an application for a deceased client", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...CLIENT_ROW, deceasedAt: new Date("2026-08-01") })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
  })

  it("refuses to open an application for a blacklisted client", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...CLIENT_ROW, blacklisted: true })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
  })

  it("blocks a deceased client before it even asks about defaulted loans", async () => {
    // Ordering is the point: telling the estate of a dead person to "resolve
    // the default first" is the wrong instruction, and the loan query is
    // pointless work once the answer is already no.
    clientFindUniqueMock.mockResolvedValue({ ...CLIENT_ROW, deceasedAt: new Date("2026-08-01") })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(false)
    expect(loanFindFirstMock).not.toHaveBeenCalled()
  })

  it("still lets an ordinary living client through", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...CLIENT_ROW, blacklisted: false, deceasedAt: null })
    const result = await prepareApplicationFields(validInput(), "t1", "u1", { action: "create" })
    expect(result.ok).toBe(true)
  })
})

describe("prepareApplicationFields — NDI/affordability pass-through", () => {
  it("rejects submission when below-MLE client expenses have no justification", async () => {
    clientFindUniqueMock.mockResolvedValue({
      ...CLIENT_ROW,
      monthlyExpenses: 0,
      expenseBreakdown: {
        ...CLIENT_ROW.expenseBreakdown,
        housing: 0,
        transport: 0,
        food: 0,
        insurance: 0,
        clothing: 0,
        medical: 0,
        other: 0,
        belowMleJustification: null,
      },
    })
    const result = await prepareApplicationFields(
      validInput({
        submitForReview: true,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
        recklessLendingConfirmed: true,
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/Regulation 23A minimum/i)
  })

  it("rejects submission when itemised expenses contradict the client expense total", async () => {
    clientFindUniqueMock.mockResolvedValue({
      ...CLIENT_ROW,
      expenseBreakdown: {
        ...CLIENT_ROW.expenseBreakdown,
        housing: CLIENT_ROW.expenseBreakdown.housing + 1,
      },
    })
    const result = await prepareApplicationFields(
      validInput({
        submitForReview: true,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
        recklessLendingConfirmed: true,
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/inconsistent/i)
  })

  it("computes the debt snapshot and NDI, and stamps ack timestamps when submitting", async () => {
    const result = await prepareApplicationFields(
      validInput({
        submitForReview: true,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
        recklessLendingConfirmed: true,
      }),
      "t1",
      "u1",
      { action: "create" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const { fields } = result

    expect(fields.totalExistingDebt).toBe(50_000)
    expect(fields.netDisposableIncome).toBe(2_000_000 - 1_000_000 - 50_000)
    expect(fields.affordabilityNDI).toBe(
      fields.netDisposableIncome -
        (fields.affordabilityResult as { submission: { inputs: { proposedInstalmentCents: number } } })
          .submission.inputs.proposedInstalmentCents,
    )
    expect(fields.affordabilityResult).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        submission: expect.objectContaining({
          stage: "SUBMISSION",
          capturedById: "u1",
          expenses: expect.objectContaining({
            sourceId: "expense-1",
            grossMonthlyIncomeCents: 2_200_000,
            breakdownTotalCents: 1_000_000,
          }),
          calculator: expect.objectContaining({
            version: "loan-calculator-v3",
            contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
          inputs: expect.objectContaining({
            monthlyIncomeCents: 2_000_000,
            monthlyExpensesCents: 1_000_000,
            applicationDebtCents: 50_000,
            clientDebtCents: 50_000,
            declaredDebtCents: 50_000,
            principalCents: 500_000,
            termDays: 30,
          }),
          inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          decisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    )
    expect(fields.existingDebtObligations).toEqual([
      {
        sourceId: "debt-1",
        provider: "Bank X",
        type: "PERSONAL_LOAN",
        balance: 500_000,
        monthlyInstalment: 50_000,
        notes: "Declared debt",
      },
    ])
    expect(fields.agreementType).toBe("SMALL")

    expect(fields.status).toBe("SUBMITTED")
    expect(fields.submittedAt).toBeInstanceOf(Date)
    expect(fields).not.toHaveProperty("pasqAcknowledgedAt")
    expect(fields).not.toHaveProperty("pasqAcknowledgedBy")
    expect(fields.clientAffordabilityDeclaredAt).toBeInstanceOf(Date)
    expect(fields.recklessLendingAssessed).toBe(true)
    expect(fields.recklessLendingAssessedAt).toBeInstanceOf(Date)
    expect(fields.recklessLendingAssessedById).toBe("u1")
  })

  it("stays DRAFT with no ack timestamps when saving as a draft", async () => {
    const result = await prepareApplicationFields(
      validInput({ submitForReview: false }),
      "t1",
      "u1",
      { action: "update" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const { fields } = result

    expect(fields.status).toBe("DRAFT")
    expect(fields.submittedAt).toBeNull()
    expect(fields).not.toHaveProperty("pasqAcknowledgedAt")
    expect(fields).not.toHaveProperty("pasqAcknowledgedBy")
    expect(fields.clientAffordabilityDeclaredAt).toBeUndefined()
    expect(fields.recklessLendingAssessed).toBeUndefined()
  })
})

describe("prepareApplicationFields — credit-life election evidence", () => {
  const submissionFields = {
    submitForReview: true,
    pasqAcknowledged: true,
    affordabilityDeclared: true,
    recklessLendingConfirmed: true,
  } as const

  it("rejects submission without an explicit election and acknowledgement", async () => {
    const result = await prepareApplicationFields(
      validInput({
        ...submissionFields,
        creditLifeElection: undefined,
        creditLifeDisclosureAcknowledged: false,
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(400)
    expect(result.body.errors).toEqual(expect.objectContaining({
      creditLifeElection: expect.any(String),
      creditLifeDisclosureAcknowledged: expect.any(String),
    }))
    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it("rejects a stale or client-tampered premium after locking the current offer", async () => {
    const result = await prepareApplicationFields(
      validInput({
        ...submissionFields,
        creditLifeMonthlyPremiumCents: 2_249,
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/offer changed/i)
    expect(queryRawMock).toHaveBeenCalledOnce()
  })

  it("does not record ACCEPTED while auto-bundling is contained", async () => {
    const result = await prepareApplicationFields(
      validInput({
        ...submissionFields,
        creditLifeElection: "ACCEPTED",
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/not available/i)
    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it("does not record ACCEPTED when the amount is at the no-cover threshold", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const result = await prepareApplicationFields(
      validInput({
        ...submissionFields,
        appliedAmount: 100_000,
        creditLifeElection: "ACCEPTED",
        creditLifeMonthlyPremiumCents: 450,
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.status).toBe(422)
    expect(result.body.error).toMatch(/not available/i)
    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it("persists the locked product, insurer, exact premium, acknowledgement, and evidence hash", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const result = await prepareApplicationFields(
      validInput({
        ...submissionFields,
        creditLifeElection: "ACCEPTED",
      }),
      "t1",
      "u1",
      { action: "create" },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.fields).toEqual(expect.objectContaining({
      creditLifeElection: "ACCEPTED",
      creditLifeProductId: CREDIT_LIFE_PRODUCT.id,
      creditLifeProductName: CREDIT_LIFE_PRODUCT.name,
      creditLifeInsurerId: CREDIT_LIFE_PRODUCT.insurerId,
      creditLifeInsurerName: CREDIT_LIFE_PRODUCT.insurer.name,
      creditLifeMonthlyPremiumCents: 2_250,
      creditLifeDisclosureVersion: "credit-life-election-v1",
      creditLifeDisclosureAcknowledgedAt: expect.any(Date),
      creditLifeDisclosureAcknowledgedBy: "c1",
      creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
        version: "credit-life-election-v1",
        election: "ACCEPTED",
        principalCents: 500_000,
        termDays: 30,
        monthlyPremiumCents: 2_250,
        productId: CREDIT_LIFE_PRODUCT.id,
        productName: CREDIT_LIFE_PRODUCT.name,
        insurerId: CREDIT_LIFE_PRODUCT.insurerId,
        insurerName: CREDIT_LIFE_PRODUCT.insurer.name,
      }),
    }))
    expect(insuranceProductFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "t1",
          type: "CREDIT_LIFE",
          active: true,
          insurer: {
            is: {
              tenantId: "t1",
              active: true,
            },
          },
        }),
      }),
    )
    const offerLockSql = (
      queryRawMock.mock.calls[0][0] as { strings?: readonly string[] }
    ).strings?.join(" ")
    expect(offerLockSql).toContain(`insurer."tenantId" =`)
    expect(offerLockSql).toContain(`insurer."active" = TRUE`)
    expect(offerLockSql).toContain(`FOR SHARE OF product, insurer`)
  })
})
