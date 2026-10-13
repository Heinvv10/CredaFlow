import { describe, expect, it, vi } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import {
  affordabilityExpenseEvidenceNeedsMleJustification,
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  ASSESSMENT_AFFORDABILITY_POLICY_VERSION,
  SUBMISSION_AFFORDABILITY_POLICY_VERSION,
  affordabilityContractEvidenceIsIntact,
  affordabilityContractCanBeDisbursed,
  affordabilityContractFingerprint,
  affordabilityDebtFingerprint,
  affordabilityDecisionFingerprint,
  affordabilityDecisionSnapshotIsIntact,
  affordabilityExpenseEvidenceIsIntact,
  affordabilityInputFingerprint,
  approvalSnapshotMatches,
  frozenApprovedTerms,
  createAffordabilityContractEvidence,
  bureauDecisionFingerprint,
  createBureauDecisionEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  InvalidAffordabilityDebtError,
  latestAffordabilitySnapshot,
  normaliseAffordabilityDebts,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  rebaseAffordabilityCalculatorEvidence,
  returnAffordabilityToDraft,
  totalAffordabilityDebt,
  withAffordabilitySnapshot,
  type AffordabilityDecisionInputs,
} from "./snapshot"

const inputs: AffordabilityDecisionInputs = {
  monthlyIncomeCents: 1_500_000,
  monthlyExpensesCents: 800_000,
  applicationDebtCents: 50_000,
  clientDebtCents: 50_000,
  declaredDebtCents: 50_000,
  bureauObligationsCents: 25_000,
  proposedInstalmentCents: 183_665,
  principalCents: 500_000,
  termDays: 90,
  productId: "personal",
  interestRatePm: 0.03,
  interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMaxCents: 105_000,
  monthlyServiceFeeCents: 6_900,
  initiationFeePayment: "DEFERRED",
  ndiBufferPct: 110,
}

const applicationDebts = [{
  sourceId: "app-debt-1",
  provider: "Bank A",
  type: "PERSONAL_LOAN",
  balanceCents: 500_000,
  monthlyInstalmentCents: 50_000,
  notes: "Declared on application",
}]

const clientDebts = [{
  sourceId: "client-debt-1",
  provider: "Bank A",
  type: "PERSONAL_LOAN",
  balanceCents: 500_000,
  monthlyInstalmentCents: 50_000,
  notes: "Client master record",
}]

const bureauEvidence = createBureauDecisionEvidence({
  check: {
    id: "bureau-1",
    clientId: "client-1",
    subjectFingerprint: "a".repeat(64),
    provider: "experian",
    createdAt: new Date("2026-07-18T12:30:00Z"),
    score: 612,
    riskGrade: "LOW",
    obligations: { totalMonthly: 25_000 },
  },
  minimumScore: 450,
  blockAdverse: false,
  override: null,
})

const calculation = calculateLoan({
  principal: inputs.principalCents,
  termDays: inputs.termDays,
  interestRatePm: inputs.interestRatePm,
  interestModel: inputs.interestModel,
  initiationFeeModel: inputs.initiationFeeModel ?? "FLAT_PCT",
  initiationFeePct: inputs.initiationFeePct,
  initiationFeeMax: inputs.initiationFeeMaxCents,
  monthlyServiceFee: inputs.monthlyServiceFeeCents,
  productType: "MICRO",
  initiationFeePayment: inputs.initiationFeePayment,
}, new Date("2026-07-18T12:42:00Z"))

const calculationStartDate = new Date("2026-07-18T12:42:00Z")
const expenseEvidence = createAffordabilityExpenseEvidence({
  grossMonthlyIncome: 1_700_000,
  monthlyIncome: inputs.monthlyIncomeCents,
  monthlyExpenses: inputs.monthlyExpensesCents,
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-18T12:00:00Z"),
    housing: 400_000,
    transport: 150_000,
    food: 150_000,
    education: 0,
    insurance: 50_000,
    clothing: 0,
    entertainment: 0,
    medical: 50_000,
    other: 0,
    belowMleJustification: null,
  },
})

function approvalSnapshot(overrides: Partial<AffordabilityDecisionInputs> = {}) {
  return createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt: new Date("2026-07-18T12:42:00Z"),
    capturedById: "officer-1",
    inputs: { ...inputs, ...overrides },
    applicationDebts,
    clientDebts,
    expenseEvidence,
    bureauEvidence,
    calculation,
    calculationStartDate,
    outcome: {
      netDisposableIncomeCents: 650_000,
      ndiAfterLoanCents: 466_335,
      requiredNdiCents: 202_032,
      isAffordable: true,
      reason: null,
    },
  })
}

function submissionSnapshot(capturedAt = new Date("2026-07-18T12:42:00.000Z")) {
  const submissionInputs = { ...inputs, bureauObligationsCents: 0 }
  const submissionCalculation = calculateLoan({
    principal: inputs.principalCents,
    termDays: inputs.termDays,
    interestRatePm: inputs.interestRatePm,
    interestModel: inputs.interestModel,
    initiationFeeModel: inputs.initiationFeeModel ?? "FLAT_PCT",
    initiationFeePct: inputs.initiationFeePct,
    initiationFeeMax: inputs.initiationFeeMaxCents,
    monthlyServiceFee: inputs.monthlyServiceFeeCents,
    productType: "MICRO",
    initiationFeePayment: inputs.initiationFeePayment,
  }, capturedAt)
  return createAffordabilitySnapshot({
    stage: "SUBMISSION",
    policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
    capturedAt,
    capturedById: "officer-1",
    inputs: submissionInputs,
    applicationDebts,
    clientDebts,
    expenseEvidence,
    bureauEvidence: null,
    calculation: submissionCalculation,
    calculationStartDate: capturedAt,
    outcome: {
      netDisposableIncomeCents: 650_000,
      ndiAfterLoanCents: 466_335,
      requiredNdiCents: 202_032,
      isAffordable: true,
      reason: null,
    },
  })
}

function withRehashedDebts(
  original: ReturnType<typeof approvalSnapshot>,
  nextApplicationDebts: ReturnType<typeof normaliseAffordabilityDebts>,
  nextClientDebts: ReturnType<typeof normaliseAffordabilityDebts> = original.debts.client,
) {
  const debts = {
    application: nextApplicationDebts,
    client: nextClientDebts,
    applicationFingerprint: affordabilityDebtFingerprint(nextApplicationDebts),
    clientFingerprint: affordabilityDebtFingerprint(nextClientDebts),
  }
  return {
    ...original,
    debts,
    decisionFingerprint: affordabilityDecisionFingerprint({
      stage: original.stage,
      policyVersion: original.policyVersion,
      capturedAt: original.capturedAt,
      capturedById: original.capturedById,
      inputs: original.inputs,
      expenses: original.expenses,
      applicationDebts: nextApplicationDebts,
      clientDebts: nextClientDebts,
      bureauEvidence: original.bureauEvidence,
      calculator: original.calculator,
      outcome: original.outcome,
    }),
  }
}

describe("requiredNdi float-drift generations", () => {
  // 186_900 × 110 / 100 = 205_590 exactly, but pre-fix float math
  // (i * (pct / 100)) ceiled to 205_591. Stored evidence from that era is
  // immutable, so the validator must accept BOTH generations while
  // rejecting anything else.
  const driftInputs: AffordabilityDecisionInputs = {
    monthlyIncomeCents: 2_800_000,
    monthlyExpensesCents: 1_200_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents: 186_900,
    principalCents: 150_000,
    termDays: 30,
    productId: "micro30",
    productType: "MICRO",
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL",
    initiationFeeModel: "FLAT_PCT" as const,
    initiationFeePct: 0.15,
    initiationFeeMaxCents: 100_000,
    monthlyServiceFeeCents: 6_900,
    initiationFeePayment: "DEFERRED",
    ndiBufferPct: 110,
  }
  const driftCapturedAt = new Date("2026-07-28T20:37:41.184Z")
  const driftCalculation = calculateLoan({
    principal: driftInputs.principalCents,
    termDays: driftInputs.termDays,
    interestRatePm: driftInputs.interestRatePm,
    interestModel: driftInputs.interestModel,
    initiationFeeModel: driftInputs.initiationFeeModel ?? "FLAT_PCT",
    initiationFeePct: driftInputs.initiationFeePct,
    initiationFeeMax: driftInputs.initiationFeeMaxCents,
    monthlyServiceFee: driftInputs.monthlyServiceFeeCents,
    productType: "MICRO",
    initiationFeePayment: driftInputs.initiationFeePayment,
  }, driftCapturedAt)
  const driftBureauEvidence = createBureauDecisionEvidence({
    check: null,
    minimumScore: 450,
    blockAdverse: false,
    override: {
      reason: "Bureau integration not yet live; manual review completed.",
      byId: "officer-1",
      at: driftCapturedAt,
    },
  })
  const driftExpenses = createAffordabilityExpenseEvidence({
    grossMonthlyIncome: null,
    monthlyIncome: driftInputs.monthlyIncomeCents,
    monthlyExpenses: driftInputs.monthlyExpensesCents,
  })

  function driftSnapshot(requiredNdiCents: number) {
    return createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt: driftCapturedAt,
      capturedById: "officer-1",
      inputs: driftInputs,
      applicationDebts: [],
      clientDebts: [],
      expenseEvidence: driftExpenses,
      bureauEvidence: driftBureauEvidence,
      calculation: driftCalculation,
      calculationStartDate: driftCapturedAt,
      outcome: {
        netDisposableIncomeCents: 1_600_000,
        ndiAfterLoanCents: 1_413_100,
        requiredNdiCents,
        isAffordable: true,
        reason: null,
      },
    })
  }

  it("pins the drift instalment so the scenario stays real", () => {
    expect(driftCalculation.monthlyInstalment).toBe(186_900)
  })
  it("accepts the integer-exact value the DB guard computes", () => {
    expect(affordabilityDecisionSnapshotIsIntact(driftSnapshot(205_590))).toBe(true)
  })
  it("accepts the legacy float-era value stored in immutable evidence", () => {
    expect(affordabilityDecisionSnapshotIsIntact(driftSnapshot(205_591))).toBe(true)
  })
  it("derives isAffordable from the STORED requiredNdi, not the recomputed one", () => {
    // NDI exactly equals the exact-formula threshold (205_590) while the
    // stored snapshot carries the legacy value (205_591): under the legacy
    // threshold the loan is NOT affordable. A validator that recomputes
    // from the exact formula would demand isAffordable=true here.
    const borderlineDebts = [{
      sourceId: "debt-borderline",
      provider: "Bank B",
      type: "PERSONAL_LOAN",
      balanceCents: 5_000_000,
      monthlyInstalmentCents: 1_394_410,
      notes: null,
    }]
    const borderlineInputs: AffordabilityDecisionInputs = {
      ...driftInputs,
      applicationDebtCents: 1_394_410,
      clientDebtCents: 0,
      declaredDebtCents: 1_394_410,
    }
    function borderlineSnapshot(outcome: {
      requiredNdiCents: number
      isAffordable: boolean
      reason: string | null
    }) {
      // SUBMISSION stage: an APPROVAL snapshot may never carry
      // isAffordable=false, and this test needs both polarities.
      return createAffordabilitySnapshot({
        stage: "SUBMISSION",
        policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
        capturedAt: driftCapturedAt,
        capturedById: "officer-1",
        inputs: borderlineInputs,
        applicationDebts: borderlineDebts,
        clientDebts: [],
        expenseEvidence: driftExpenses,
        bureauEvidence: driftBureauEvidence,
        calculation: driftCalculation,
        calculationStartDate: driftCapturedAt,
        outcome: {
          netDisposableIncomeCents: 205_590,
          ndiAfterLoanCents: 205_590 - 186_900,
          ...outcome,
        },
      })
    }
    expect(affordabilityDecisionSnapshotIsIntact(borderlineSnapshot({
      requiredNdiCents: 205_591,
      isAffordable: false,
      reason: "Net disposable income 205590 below required 205591 (instalment × 110%).",
    }))).toBe(true)
    expect(affordabilityDecisionSnapshotIsIntact(borderlineSnapshot({
      requiredNdiCents: 205_591,
      isAffordable: true,
      reason: null,
    }))).toBe(false)
    expect(affordabilityDecisionSnapshotIsIntact(borderlineSnapshot({
      requiredNdiCents: 205_590,
      isAffordable: true,
      reason: null,
    }))).toBe(true)
  })

  it("stops accepting the legacy value for snapshots captured after the cutover", () => {
    const lateCapturedAt = new Date("2026-09-15T09:00:00.000Z")
    const lateCalculation = calculateLoan({
      principal: driftInputs.principalCents,
      termDays: driftInputs.termDays,
      interestRatePm: driftInputs.interestRatePm,
      interestModel: driftInputs.interestModel,
      initiationFeeModel: driftInputs.initiationFeeModel ?? "FLAT_PCT",
      initiationFeePct: driftInputs.initiationFeePct,
      initiationFeeMax: driftInputs.initiationFeeMaxCents,
      monthlyServiceFee: driftInputs.monthlyServiceFeeCents,
      productType: "MICRO",
      initiationFeePayment: driftInputs.initiationFeePayment,
    }, lateCapturedAt)
    function lateSnapshot(requiredNdiCents: number) {
      return createAffordabilitySnapshot({
        stage: "APPROVAL",
        policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
        capturedAt: lateCapturedAt,
        capturedById: "officer-1",
        inputs: driftInputs,
        applicationDebts: [],
        clientDebts: [],
        expenseEvidence: driftExpenses,
        bureauEvidence: driftBureauEvidence,
        calculation: lateCalculation,
        calculationStartDate: lateCapturedAt,
        outcome: {
          netDisposableIncomeCents: 1_600_000,
          ndiAfterLoanCents: 1_413_100,
          requiredNdiCents,
          isAffordable: true,
          reason: null,
        },
      })
    }
    expect(affordabilityDecisionSnapshotIsIntact(lateSnapshot(205_590))).toBe(true)
    expect(affordabilityDecisionSnapshotIsIntact(lateSnapshot(205_591))).toBe(false)
  })

  it("rejects any other requiredNdi", () => {
    expect(affordabilityDecisionSnapshotIsIntact(driftSnapshot(205_592))).toBe(false)
    expect(affordabilityDecisionSnapshotIsIntact(driftSnapshot(205_589))).toBe(false)
  })
})

describe("affordability decision snapshots", () => {
  it("accepts an approval calculation established by the PASQ before the decision", () => {
    const decisionAt = new Date("2026-07-18T13:00:00.000Z")
    const snapshot = createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt: decisionAt,
      capturedById: "officer-1",
      inputs,
      applicationDebts,
      clientDebts,
      expenseEvidence,
      bureauEvidence,
      calculation,
      calculationStartDate,
      outcome: {
        netDisposableIncomeCents: 650_000,
        ndiAfterLoanCents: 466_335,
        requiredNdiCents: 202_032,
        isAffordable: true,
        reason: null,
      },
    })

    expect(snapshot.calculator.startDate).toBe(calculationStartDate.toISOString())
    expect(snapshot.capturedAt).toBe(decisionAt.toISOString())
    expect(affordabilityDecisionSnapshotIsIntact(snapshot)).toBe(true)
  })

  it("rejects an approval calculation dated after the decision", () => {
    const decisionAt = new Date("2026-07-18T12:00:00.000Z")
    const snapshot = createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt: decisionAt,
      capturedById: "officer-1",
      inputs,
      applicationDebts,
      clientDebts,
      expenseEvidence,
      bureauEvidence,
      calculation,
      calculationStartDate,
      outcome: {
        netDisposableIncomeCents: 650_000,
        ndiAfterLoanCents: 466_335,
        requiredNdiCents: 202_032,
        isAffordable: true,
        reason: null,
      },
    })

    expect(affordabilityDecisionSnapshotIsIntact(snapshot)).toBe(false)
  })

  it.each([
    [null, "null"],
    ["corrupt", "a string"],
    [{ monthlyInstalment: 250_000, balance: 1_000_000 }, "an object"],
  ])("rejects persisted debt evidence represented as %s (%s)", (value, _description) => {
    expect(() => readAffordabilityDebtInputs(value)).toThrow(
      InvalidAffordabilityDebtError,
    )
  })

  it.each([
    [-1, "negative"],
    ["1000", "numeric string"],
    [null, "null"],
    [false, "boolean"],
    [1.5, "fractional"],
    [2_147_483_648, "outside the database range"],
  ])("rejects %s debt evidence instead of silently changing it (%s)", (monthlyInstalment, _description) => {
    expect(() => normaliseAffordabilityDebts([{
      creditor: "Synthetic Bank",
      type: "PERSONAL_LOAN",
      balance: 1_000_000,
      monthlyInstalment: monthlyInstalment as never,
    }])).toThrow(InvalidAffordabilityDebtError)
  })

  it.each([
    [{ creditor: "", type: "PERSONAL_LOAN" }, "provider"],
    [{ creditor: "Synthetic Bank", type: "" }, "type"],
  ])("rejects incomplete identified debt evidence (%s)", (identity, field) => {
    expect(() => normaliseAffordabilityDebts([{
      ...identity,
      balance: 0,
      monthlyInstalment: 0,
    }])).toThrow(expect.objectContaining({
      field: `existingDebtObligations.0.${field}`,
    }))
  })

  it("rejects duplicate non-null source identifiers", () => {
    expect(() => normaliseAffordabilityDebts([
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
    ])).toThrow(expect.objectContaining({
      field: "existingDebtObligations.1.sourceId",
    }))
  })

  it("preserves valid zero-cent debt evidence", () => {
    expect(normaliseAffordabilityDebts([{
      creditor: "Synthetic Bank",
      type: "SETTLED_ACCOUNT",
      balance: 0,
      monthlyInstalment: 0,
    }])).toEqual([expect.objectContaining({
      balanceCents: 0,
      monthlyInstalmentCents: 0,
    })])
  })

  it("rejects a monthly-debt aggregate that cannot be persisted in a Prisma Int", () => {
    const debts = normaliseAffordabilityDebts([
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
    ])

    expect(() => totalAffordabilityDebt(debts)).toThrow(
      InvalidAffordabilityDebtError,
    )
  })

  it("returns false instead of throwing for an over-range snapshot debt aggregate", () => {
    const snapshot = approvalSnapshot()
    snapshot.debts.client = [
      {
        ...clientDebts[0],
        sourceId: "client-debt-a",
        monthlyInstalmentCents: 1_500_000_000,
      },
      {
        ...clientDebts[0],
        sourceId: "client-debt-b",
        monthlyInstalmentCents: 1_500_000_000,
      },
    ]

    expect(() => affordabilityDecisionSnapshotIsIntact(snapshot)).not.toThrow()
    expect(affordabilityDecisionSnapshotIsIntact(snapshot)).toBe(false)
  })

  it("rejects an over-range debt balance even when public fingerprints are recomputed", () => {
    const original = approvalSnapshot()
    const tampered = withRehashedDebts(original, [{
      ...original.debts.application[0],
      balanceCents: 2_147_483_648,
    }])

    expect(affordabilityDecisionSnapshotIsIntact(tampered)).toBe(false)
  })

  it("rejects unidentified persisted debt even when public fingerprints are recomputed", () => {
    const original = approvalSnapshot()
    const tampered = withRehashedDebts(original, [{
      ...original.debts.application[0],
      provider: "",
    }])

    expect(affordabilityDecisionSnapshotIsIntact(tampered)).toBe(false)
  })

  it("produces a stable fingerprint for identical decision inputs", () => {
    expect(affordabilityInputFingerprint({ ...inputs })).toBe(
      affordabilityInputFingerprint(inputs),
    )
  })

  it("detects the walkthrough's post-approval expense erasure", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual(expect.objectContaining({ ok: true }))
    expect(
      approvalSnapshotMatches(store, {
        inputs: { ...inputs, monthlyExpensesCents: 0 },
        expenseEvidence: createAffordabilityExpenseEvidence({
          monthlyIncome: inputs.monthlyIncomeCents,
          monthlyExpenses: 0,
        }),
        applicationDebts,
        clientDebts,
        bureauEvidence,
        calculation,
      }),
    ).toEqual({ ok: false, reason: "changed" })
  })

  it("detects debt-evidence changes even when the monthly total is unchanged", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts: [{ ...applicationDebts[0], provider: "Different lender" }],
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("detects expense-category or MLE-evidence changes when the total is unchanged", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())
    const recategorisedExpenses = createAffordabilityExpenseEvidence({
      grossMonthlyIncome: 1_700_000,
      monthlyIncome: inputs.monthlyIncomeCents,
      monthlyExpenses: inputs.monthlyExpensesCents,
      expenseBreakdown: {
        id: "expense-1",
        updatedAt: new Date("2026-07-18T12:00:00Z"),
        housing: 300_000,
        transport: 250_000,
        food: 150_000,
        insurance: 50_000,
        medical: 50_000,
      },
    })

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence: recategorisedExpenses,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("detects a different bureau decision record with the same score and obligations", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())
    const replacementBureau = {
      ...bureauEvidence,
      check: bureauEvidence.check && { ...bureauEvidence.check, id: "bureau-2" },
    }

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence: replacementBureau,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("recomputes the approval schedule at its frozen start date when time has passed", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())
    const laterCalculation = calculateLoan({
      principal: inputs.principalCents,
      termDays: inputs.termDays,
      interestRatePm: inputs.interestRatePm,
      interestModel: inputs.interestModel,
      initiationFeeModel: inputs.initiationFeeModel ?? "FLAT_PCT",
      initiationFeePct: inputs.initiationFeePct,
      initiationFeeMax: inputs.initiationFeeMaxCents,
      monthlyServiceFee: inputs.monthlyServiceFeeCents,
      productType: "MICRO",
      initiationFeePayment: inputs.initiationFeePayment,
    }, new Date("2026-07-27T12:42:00Z"))

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation: laterCalculation,
    })).toEqual(expect.objectContaining({ ok: true }))
  })

  it("detects live calculator pricing-output drift even when scalar inputs are unchanged", () => {
    const store = withAffordabilitySnapshot(null, approvalSnapshot())
    const changedCalculation = {
      ...calculation,
      totalInterest: calculation.totalInterest + 1,
      totalRepayable: calculation.totalRepayable + 1,
      schedule: calculation.schedule.map((item, index) => index === 0
        ? {
            ...item,
            interestDue: item.interestDue + 1,
            totalDue: item.totalDue + 1,
          }
        : item),
    }

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation: changedCalculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("rejects below-Regulation-23A expense evidence without a justification", () => {
    const evidence = createAffordabilityExpenseEvidence({
      grossMonthlyIncome: 1_000_000,
      monthlyIncome: 900_000,
      monthlyExpenses: 0,
      expenseBreakdown: {
        id: "website-expense",
        updatedAt: new Date("2026-07-18T12:00:00Z"),
        belowMleJustification: null,
      },
    })

    expect(evidence.mle.belowMinimum).toBe(true)
    expect(affordabilityExpenseEvidenceIsIntact(evidence)).toBe(false)
  })

  it("uses positive net income for the MLE floor when legacy gross income is zero", () => {
    const evidence = createAffordabilityExpenseEvidence({
      grossMonthlyIncome: 0,
      monthlyIncome: 1_500_000,
      monthlyExpenses: 0,
    })

    expect(evidence.mle.basisIncomeCents).toBe(1_500_000)
    expect(evidence.mle.minimumExpenseCents).toBeGreaterThan(0)
    expect(evidence.mle.belowMinimum).toBe(true)
    expect(affordabilityExpenseEvidenceNeedsMleJustification(evidence)).toBe(true)
    expect(affordabilityExpenseEvidenceIsIntact(evidence)).toBe(false)
  })

  it("rejects itemised expenses that contradict the client expense total", () => {
    const evidence = createAffordabilityExpenseEvidence({
      grossMonthlyIncome: 1_700_000,
      monthlyIncome: 1_500_000,
      monthlyExpenses: 800_000,
      expenseBreakdown: {
        id: "expense-1",
        updatedAt: new Date("2026-07-18T12:00:00Z"),
        housing: 400_000,
        transport: 100_000,
        food: 100_000,
      },
    })

    expect(evidence.breakdownTotalCents).toBe(600_000)
    expect(affordabilityExpenseEvidenceIsIntact(evidence)).toBe(false)
  })

  it("keeps evidence fingerprints stable after JSONB reorders nested object keys", () => {
    const original = approvalSnapshot()
    const reverseKeys = <T extends object>(value: T): T =>
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).reverse(),
      ) as T
    const reordered = {
      ...original,
      inputs: reverseKeys(original.inputs),
      debts: {
        ...original.debts,
        application: original.debts.application.map((debt) => reverseKeys(debt)),
        client: original.debts.client.map((debt) => reverseKeys(debt)),
      },
      bureauEvidence: original.bureauEvidence && reverseKeys({
        ...original.bureauEvidence,
        check: original.bureauEvidence.check && reverseKeys(original.bureauEvidence.check),
        policy: reverseKeys(original.bureauEvidence.policy),
        override: original.bureauEvidence.override && reverseKeys(original.bureauEvidence.override),
      }),
      outcome: reverseKeys(original.outcome),
    }

    expect(affordabilityDecisionSnapshotIsIntact(reordered)).toBe(true)
  })

  it("detects tampering with the frozen contractual due dates", () => {
    const snapshot = approvalSnapshot()
    const tampered = {
      ...snapshot,
      calculator: {
        ...snapshot.calculator,
        schedule: snapshot.calculator.schedule.map((item, index) => index === 0
          ? { ...item, dueDate: "2027-01-01T00:00:00.000Z" }
          : item),
      },
    }
    const store = withAffordabilitySnapshot(null, tampered)

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("rejects tampered stored inputs even if their local and decision hashes are recomputed", () => {
    const original = approvalSnapshot()
    const tamperedInputs = {
      ...original.inputs,
      principalCents: original.inputs.principalCents + 1,
    }
    const tampered = {
      ...original,
      inputs: tamperedInputs,
      inputFingerprint: affordabilityInputFingerprint(tamperedInputs),
      decisionFingerprint: affordabilityDecisionFingerprint({
        stage: original.stage,
        policyVersion: original.policyVersion,
        capturedAt: original.capturedAt,
        capturedById: original.capturedById,
        inputs: tamperedInputs,
        expenses: original.expenses,
        applicationDebts: original.debts.application,
        clientDebts: original.debts.client,
        bureauEvidence: original.bureauEvidence,
        calculator: original.calculator,
        outcome: original.outcome,
      }),
    }

    expect(affordabilityDecisionSnapshotIsIntact(tampered)).toBe(false)
    expect(approvalSnapshotMatches(withAffordabilitySnapshot(null, tampered), {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("rejects tampered stored debts and outcome rather than trusting untouched sub-fingerprints", () => {
    const original = approvalSnapshot()
    const tamperedDebts = {
      ...original,
      debts: {
        ...original.debts,
        application: original.debts.application.map((debt) => ({
          ...debt,
          monthlyInstalmentCents: debt.monthlyInstalmentCents + 1,
        })),
      },
    }
    const tamperedOutcome = {
      ...original,
      outcome: {
        ...original.outcome,
        netDisposableIncomeCents: original.outcome.netDisposableIncomeCents + 1,
      },
    }

    expect(affordabilityDecisionSnapshotIsIntact(tamperedDebts)).toBe(false)
    expect(affordabilityDecisionSnapshotIsIntact(tamperedOutcome)).toBe(false)
    expect(tamperedDebts.debts.applicationFingerprint).toBe(
      affordabilityDebtFingerprint(original.debts.application),
    )
  })

  it("fails closed when a malformed calculator date has a recomputed fingerprint", () => {
    const snapshot = approvalSnapshot()
    const malformedWithoutFingerprints = {
      ...snapshot.calculator,
      startDate: "not-a-date",
    }
    const { pricingFingerprint, contractFingerprint: _oldContract, ...payload } = malformedWithoutFingerprints
    const malformed = {
      ...malformedWithoutFingerprints,
      pricingFingerprint,
      contractFingerprint: affordabilityContractFingerprint(payload),
    }
    const store = withAffordabilitySnapshot(null, {
      ...snapshot,
      calculator: malformed,
    })

    expect(approvalSnapshotMatches(store, {
      inputs,
      expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculation,
    })).toEqual({ ok: false, reason: "changed" })
  })

  it("fails closed without throwing when stored calculator evidence is missing", () => {
    const malformed = {
      ...approvalSnapshot(),
      calculator: undefined,
    }

    expect(() => affordabilityDecisionSnapshotIsIntact(
      malformed as unknown as ReturnType<typeof approvalSnapshot>,
    )).not.toThrow()
    expect(affordabilityDecisionSnapshotIsIntact(
      malformed as unknown as ReturnType<typeof approvalSnapshot>,
    )).toBe(false)
  })

  it("fails closed for legacy records with no versioned approval snapshot", () => {
    expect(
      approvalSnapshotMatches(
        { ndi: 700_000, serverComputed: true },
        { inputs, expenseEvidence, applicationDebts, clientDebts, bureauEvidence, calculation },
      ),
    ).toEqual({ ok: false, reason: "missing" })
  })

  it("preserves legacy evidence and returns the newest available snapshot", () => {
    const legacy = { ndi: 700_000, serverComputed: true }
    const submission = submissionSnapshot()
    const store = withAffordabilitySnapshot(legacy, submission)

    expect(readAffordabilitySnapshotStore(store).legacy).toEqual(legacy)
    expect(latestAffordabilitySnapshot(store)?.stage).toBe("SUBMISSION")
  })

  it("discards malformed versioned snapshot candidates without throwing", () => {
    const malformed = {
      schemaVersion: 3,
      submission: null,
      assessment: { capturedAt: "2026-01-01T00:00:00.000Z" },
    }

    expect(() => latestAffordabilitySnapshot(malformed)).not.toThrow()
    expect(latestAffordabilitySnapshot(malformed)).toBeNull()
  })

  it("archives an earlier submission snapshot when the application is resubmitted", () => {
    const first = submissionSnapshot(new Date("2026-07-18T12:42:00.000Z"))
    const second = submissionSnapshot(new Date("2026-07-19T12:42:00.000Z"))

    const store = withAffordabilitySnapshot(
      withAffordabilitySnapshot(null, first),
      second,
    )

    expect(store.submission).toBe(second)
    expect(store.submissionHistory).toEqual([first])
    expect(affordabilityDecisionSnapshotIsIntact(first)).toBe(true)
    expect(affordabilityDecisionSnapshotIsIntact(second)).toBe(true)
  })

  it("archives and clears the current submission when returning to draft", () => {
    const current = withAffordabilitySnapshot(null, {
      ...approvalSnapshot(),
      stage: "SUBMISSION",
      policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
    })

    const returned = returnAffordabilityToDraft(current)

    expect(returned.submission).toBeUndefined()
    expect(returned.submissionHistory).toEqual([current.submission])
  })

  it("selects the newest captured snapshot instead of preferring a stale assessment", () => {
    const assessment = createAffordabilitySnapshot({
      stage: "ASSESSMENT",
      policyVersion: ASSESSMENT_AFFORDABILITY_POLICY_VERSION,
      capturedAt: new Date("2026-07-18T12:42:00Z"),
      capturedById: "officer-1",
      inputs: { ...inputs, bureauObligationsCents: 0, ndiBufferPct: 100 },
      applicationDebts,
      clientDebts,
      expenseEvidence,
      bureauEvidence: null,
      calculation,
      calculationStartDate,
      outcome: {
        netDisposableIncomeCents: 650_000,
        ndiAfterLoanCents: 466_335,
        requiredNdiCents: 183_665,
        isAffordable: true,
        reason: null,
      },
    })
    const submissionAt = new Date("2026-07-18T13:42:00Z")
    const submissionCalculation = calculateLoan({
      principal: inputs.principalCents,
      termDays: inputs.termDays,
      interestRatePm: inputs.interestRatePm,
      interestModel: inputs.interestModel,
      initiationFeeModel: inputs.initiationFeeModel ?? "FLAT_PCT",
      initiationFeePct: inputs.initiationFeePct,
      initiationFeeMax: inputs.initiationFeeMaxCents,
      monthlyServiceFee: inputs.monthlyServiceFeeCents,
      productType: "MICRO",
      initiationFeePayment: inputs.initiationFeePayment,
    }, submissionAt)
    const submission = createAffordabilitySnapshot({
      stage: "SUBMISSION",
      policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
      capturedAt: submissionAt,
      capturedById: "client-1",
      inputs: {
        ...inputs,
        bureauObligationsCents: 0,
        ndiBufferPct: 100,
        proposedInstalmentCents: submissionCalculation.monthlyInstalment,
      },
      applicationDebts,
      clientDebts,
      expenseEvidence,
      bureauEvidence: null,
      calculation: submissionCalculation,
      calculationStartDate: submissionAt,
      outcome: {
        netDisposableIncomeCents: 650_000,
        ndiAfterLoanCents: 650_000 - submissionCalculation.monthlyInstalment,
        requiredNdiCents: submissionCalculation.monthlyInstalment,
        isAffordable: true,
        reason: null,
      },
    })
    const store = withAffordabilitySnapshot(
      withAffordabilitySnapshot(null, assessment),
      submission,
    )

    expect(latestAffordabilitySnapshot(store)?.stage).toBe("SUBMISSION")
    expect(latestAffordabilitySnapshot(store)?.capturedAt).toBe(submissionAt.toISOString())
  })

  it("binds the final contract to the acknowledged PASQ money and rebased schedule", () => {
    const approval = approvalSnapshot()
    const establishedAt = new Date("2026-07-18T12:42:00Z")
    const pasqDocumentSha256 = "a".repeat(64)
    const contract = createAffordabilityContractEvidence(approval, establishedAt, {
      documentSha256: pasqDocumentSha256,
      calculator: approval.calculator,
    })

    expect(affordabilityContractEvidenceIsIntact(contract, approval)).toBe(true)
    expect(contract.acceptedPasqDocumentSha256).toBe(pasqDocumentSha256)
    expect(contract.acceptedPasqContractFingerprint).toBe(
      approval.calculator.contractFingerprint,
    )
    expect(contract.calculator.pricingFingerprint).toBe(approval.calculator.pricingFingerprint)
    expect(contract.calculator.startDate).toBe(establishedAt.toISOString())
    expect(contract.calculator.schedule[0].dueDate).toBe(
      rebaseAffordabilityCalculatorEvidence(
        approval.calculator,
        establishedAt,
      ).schedule[0].dueDate,
    )
    // These assert the SAME-DAY rule, which applies only to
    // DEBIT_ORDER (its mandate fixes the collection dates before payout). Passed
    // explicitly so the assertions keep testing what they were written to test;
    // the EFT relaxation has its own describe block above.
    expect(affordabilityContractCanBeDisbursed(
      contract,
      new Date("2026-07-18T13:00:00Z"),
      "DEBIT_ORDER",
    )).toBe(true)
    expect(affordabilityContractCanBeDisbursed(
      contract,
      new Date("2026-07-18T21:59:59Z"),
      "DEBIT_ORDER",
    )).toBe(true)
    expect(affordabilityContractCanBeDisbursed(
      contract,
      new Date("2026-07-18T22:00:00Z"),
      "DEBIT_ORDER",
    )).toBe(false)
    expect(affordabilityContractCanBeDisbursed(
      contract,
      new Date(contract.calculator.schedule[0].dueDate),
      "DEBIT_ORDER",
    )).toBe(false)
    expect(affordabilityContractEvidenceIsIntact({
      ...contract,
      establishedAt: "2026-07-19T12:42:00.000Z",
    }, approval)).toBe(false)
    expect(affordabilityContractEvidenceIsIntact({
      ...contract,
      acceptedPasqDocumentSha256: "b".repeat(64),
    }, approval)).toBe(false)
  })

  // Every caller names the instant this gate is evaluated at -- the consumer's
  // signature time, the countersign time, the payout time -- because "now" and
  // "when the event actually happened" are different facts. Conflating them is
  // what made a wet-ink signature given on 4 August 2026 unrecordable the next
  // morning, which in turn left agreementSignedAt NULL and let the system
  // supersede the very document the consumer had signed.
  //
  // An absent instant is therefore missing evidence, and missing evidence must
  // fail closed rather than quietly fall back to the wall clock.
  //
  // The clock is frozen to the contract's own day deliberately: under a
  // defaulted parameter the absent-instant call resolves to `new Date()`, lands
  // on the established day, and returns true. Without the frozen clock this
  // assertion would pass for the irrelevant reason that the fixture date is not
  // today, and would keep passing if the default came back.
  // The same-day rule is now scoped to the repayment method.
  //
  // A DEBIT_ORDER loan has a mandate the consumer signs BEFORE payout, and that
  // mandate authorises collection on specific dates. lib/loan/debit-mandate.ts
  // validates the booked schedule against those exact dates, and a signed
  // mandate cannot be quietly amended — so for a debit order the payout must
  // stay on the established day, which keeps the mandate correct by
  // construction.
  //
  // An EFT loan has no mandate and nothing authorising dates in advance, so the
  // statutory s92(3) window is the only bound it needs. That is where
  // relaxing the same-day rule actually helps.
  //
  // An UNSET method takes the strict path. We do not know what will be
  // collected, so the safe answer is the one that was already true.
  describe("same-day payout is required only where a mandate binds the dates", () => {
    const establishedAt = new Date("2026-07-18T12:42:00Z")   // a Saturday
    const contractFor = () => {
      const approval = approvalSnapshot()
      return createAffordabilityContractEvidence(approval, establishedAt, {
        documentSha256: "a".repeat(64),
        calculator: approval.calculator,
      })
    }
    // 00:00 SAST the day after establishment — inside the five-business-day
    // window (which runs to Friday 2026-07-24) but a different calendar day.
    const nextDay = new Date("2026-07-18T22:00:00Z")
    const sameDay = new Date("2026-07-18T13:00:00Z")

    it("admits a later day for EFT while the quotation is still binding", () => {
      expect(affordabilityContractCanBeDisbursed(contractFor(), nextDay, "EFT"))
        .toBe(true)
    })

    it("still refuses a later day for DEBIT_ORDER", () => {
      expect(affordabilityContractCanBeDisbursed(contractFor(), nextDay, "DEBIT_ORDER"))
        .toBe(false)
    })

    it("fails closed when the repayment method is not yet known", () => {
      expect(affordabilityContractCanBeDisbursed(contractFor(), nextDay, null))
        .toBe(false)
      expect(affordabilityContractCanBeDisbursed(contractFor(), nextDay, undefined))
        .toBe(false)
    })

    it("admits the established day for every method", () => {
      for (const method of ["EFT", "DEBIT_ORDER", null] as const) {
        expect(affordabilityContractCanBeDisbursed(contractFor(), sameDay, method))
          .toBe(true)
      }
    })

    it("refuses EFT once the quotation window has closed", () => {
      // 2026-07-25 is past the 2026-07-24 expiry. Relaxing the calendar-day rule
      // must not leave an EFT contract actionable indefinitely — s92(3) becomes
      // the only thing holding the line, so it has to actually hold it.
      expect(affordabilityContractCanBeDisbursed(
        contractFor(), new Date("2026-07-25T09:00:00Z"), "EFT",
      )).toBe(false)
    })
  })

  it("refuses to answer when the evaluation instant is absent", () => {
    const approval = approvalSnapshot()
    const establishedAt = new Date("2026-07-18T12:42:00Z")
    const contract = createAffordabilityContractEvidence(approval, establishedAt, {
      documentSha256: "a".repeat(64),
      calculator: approval.calculator,
    })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-18T13:00:00Z"))
      // Control: at this very instant the contract IS disbursable, so a silent
      // fallback to the wall clock would answer true.
      expect(affordabilityContractCanBeDisbursed(
        contract,
        new Date("2026-07-18T13:00:00Z"),
        "DEBIT_ORDER",
      )).toBe(true)

      expect(affordabilityContractCanBeDisbursed(
        contract,
        undefined as unknown as Date,
        "DEBIT_ORDER",
      )).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses to establish or disburse after the five-business-day quote window", () => {
    const approval = approvalSnapshot()
    const staleCalculator = rebaseAffordabilityCalculatorEvidence(
      approval.calculator,
      new Date("2026-07-10T12:42:00.000Z"),
    )

    expect(() => createAffordabilityContractEvidence(
      approval,
      new Date("2026-07-18T12:42:00.000Z"),
      {
        documentSha256: "a".repeat(64),
        calculator: staleCalculator,
      },
    )).toThrow(/binding approved and acknowledged PASQ/i)

    const contract = createAffordabilityContractEvidence(
      approval,
      new Date("2026-07-18T12:42:00.000Z"),
      {
        documentSha256: "a".repeat(64),
        calculator: approval.calculator,
      },
    )
    expect(affordabilityContractCanBeDisbursed(
      contract,
      new Date("2026-07-27T00:00:00.000Z"),
      "DEBIT_ORDER",
    )).toBe(false)
  })
})

// frozenApprovedTerms is the SOLE authority for the price of every approved
// loan -- quotation minting, agreement generation, signing, and disbursement all
// derive from it. Reading terms back out of stored JSON is only defensible
// because this function refuses a snapshot that fails its own integrity
// fingerprint, so that refusal is the load-bearing assertion and must be
// exercised directly. (Both guards were previously deletable with the entire
// suite still green.)
describe("frozenApprovedTerms", () => {
  it("returns the approved terms for an intact current-generation snapshot", () => {
    const result = frozenApprovedTerms(withAffordabilitySnapshot(null, approvalSnapshot()))

    expect(result).toEqual({ ok: true, terms: approvalSnapshot().inputs })
  })

  it("reports missing when there is no approval snapshot at all", () => {
    expect(frozenApprovedTerms(null)).toEqual({ ok: false, reason: "missing" })
    expect(frozenApprovedTerms(withAffordabilitySnapshot(null, submissionSnapshot())))
      .toEqual({ ok: false, reason: "missing" })
  })

  it("reports missing for a superseded policy generation", () => {
    // A snapshot minted under an older policy cannot be trusted to price a loan
    // under the current one, even if it is internally consistent.
    const stale = { ...approvalSnapshot(), policyVersion: "approval-ndi-v0" }

    expect(frozenApprovedTerms(withAffordabilitySnapshot(null, stale as never)))
      .toEqual({ ok: false, reason: "missing" })
  })

  it("refuses a snapshot whose frozen rate was edited in place", () => {
    // The exact attack the freeze creates: the stored terms are now what the
    // consumer is charged, so editing interestRatePm directly in the JSON would
    // reprice a live loan if the integrity fingerprint were not checked.
    const original = approvalSnapshot()
    const tampered = {
      ...original,
      inputs: { ...original.inputs, interestRatePm: original.inputs.interestRatePm * 2 },
    }

    expect(affordabilityDecisionSnapshotIsIntact(tampered as never)).toBe(false)
    expect(frozenApprovedTerms(withAffordabilitySnapshot(null, tampered as never)))
      .toEqual({ ok: false, reason: "changed" })
  })

  it("refuses a snapshot whose decision fingerprint was stripped", () => {
    const original = approvalSnapshot()
    const tampered = { ...original, decisionFingerprint: "0".repeat(64) }

    expect(frozenApprovedTerms(withAffordabilitySnapshot(null, tampered as never)))
      .toEqual({ ok: false, reason: "changed" })
  })
})

// Computed with the snapshot code as it was before the simulated marker existed.
const PINNED_GENUINE_BUREAU_FINGERPRINT = "114dd599c656e82194a625ea45b32db49e2d206197d1bc894206d42d271730cc"

describe("simulated bureau evidence in the sealed snapshot", () => {
  const evidenceFor = (obligations: unknown) =>
    createBureauDecisionEvidence({
      check: {
        id: "bureau-1",
        clientId: "client-1",
        subjectFingerprint: "a".repeat(64),
        provider: "experian",
        createdAt: new Date("2026-07-18T12:30:00Z"),
        score: 612,
        riskGrade: "LOW",
        obligations,
      },
      minimumScore: 450,
      blockAdverse: false,
      override: null,
    })

  it("leaves a genuine check without the field", () => {
    expect(evidenceFor({ totalMonthly: 25_000 }).check).not.toHaveProperty("simulated")
  })

  it("carries simulated: true on a simulated check", () => {
    expect(evidenceFor({ totalMonthly: 25_000, simulated: true }).check?.simulated).toBe(true)
  })

  it("keeps the genuine-check fingerprint byte-identical to the pinned pre-change value", () => {
    expect(bureauDecisionFingerprint(evidenceFor({ totalMonthly: 25_000 }))).toBe(
      PINNED_GENUINE_BUREAU_FINGERPRINT,
    )
  })

  it("changes the fingerprint when the check is simulated", () => {
    expect(bureauDecisionFingerprint(evidenceFor({ totalMonthly: 25_000, simulated: true }))).not.toBe(
      PINNED_GENUINE_BUREAU_FINGERPRINT,
    )
  })
})

describe("snapshot validation of the simulated marker", () => {
  const sealedWith = (simulated: unknown) => {
    const snapshot = approvalSnapshot()
    const check = { ...snapshot.bureauEvidence!.check!, ...(simulated === undefined ? {} : { simulated }) }
    return { ...snapshot, bureauEvidence: { ...snapshot.bureauEvidence!, check } }
  }

  it("accepts a snapshot whose bureau check is sealed as simulated", () => {
    const sealed = approvalSnapshot()
    const simulated = createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt: new Date("2026-07-18T12:42:00Z"),
      capturedById: "officer-1",
      inputs,
      applicationDebts,
      clientDebts,
      expenseEvidence,
      bureauEvidence: {
        ...sealed.bureauEvidence!,
        check: { ...sealed.bureauEvidence!.check!, simulated: true },
      },
      calculation,
      calculationStartDate,
      outcome: sealed.outcome,
    })
    expect(affordabilityDecisionSnapshotIsIntact(simulated)).toBe(true)
  })

  it("rejects a simulated marker that is not exactly true", () => {
    expect(affordabilityDecisionSnapshotIsIntact(sealedWith("yes") as never)).toBe(false)
  })
})
