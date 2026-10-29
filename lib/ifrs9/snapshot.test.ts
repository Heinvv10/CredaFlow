import { describe, expect, it } from "vitest"
import { assessLoan, buildSnapshot, type RunContext, type RunLoan } from "./snapshot"
import { DEFAULT_SETTINGS, type EclParameter } from "./types"

const parameters: EclParameter[] = [
  { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 },
  { scopeKey: "DEFAULT", stage: 2, pdBps: 1500, lgdBps: 5000 },
  { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
]
const at = (iso: string): RunContext => ({
  settings: { ...DEFAULT_SETTINGS, enabled: true }, parameters, runAt: new Date(`${iso}T12:00:00+02:00`), chargesLive: true,
})

// R6 000 over six month-end instalments Jun-Nov 2026: R1 000 principal + R100 interest + R50 fees each.
const month = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30"]
const schedule = (paid: number[]) =>
  month.map((d, i) => ({
    dueDate: new Date(`${d}T00:00:00.000Z`), principalDue: 100_000, interestDue: 10_000, feesDue: 5_000, totalDue: 115_000, totalPaid: paid[i] ?? 0,
  }))
const baseLoan = (over: Partial<RunLoan>): RunLoan => ({
  id: "loan1", reference: "L-1", productId: "p1", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", debtReview: false,
  startDate: new Date("2026-05-31T00:00:00.000Z"), principal: 600_000, outstandingPrincipal: 0, chargesOutstanding: 0, flags: [],
  schedule: [], ...over,
})

describe("a performing loan (Stage 1)", () => {
  // Jun-Sep paid in full on 10 Oct 2026; Oct (due 31 Oct) not yet due.
  const loan = baseLoan({ outstandingPrincipal: 200_000, schedule: schedule([115_000, 115_000, 115_000, 115_000]) })

  it("provisions 12-month ECL on principal plus the interest accrued since the last due date", () => {
    const ctx = at("2026-10-10")
    const a = assessLoan(loan, ctx, null)
    expect(a).toMatchObject({ dpd: 0, suspended: false, staging: { stage: 1, reasons: [] } })
    const s = buildSnapshot(loan, ctx, a, 0)
    // accrued: R100.00 x 10 of 31 days = 3 225.8c -> 3 226; EAD 200 000 + 3 226
    expect(s).toMatchObject({
      runDate: "2026-10-10", daysPastDue: 0, stage: 1, previousStage: null, outstandingPrincipalCents: 200_000,
      unpaidInterestCents: 0, unpaidFeesCents: 0, accruedInterestCents: 3_226, eadCents: 203_226,
      parameterScope: "DEFAULT", pdBps: 200, lgdBps: 4500,
      // 203 226 x 2% x 45% = 1 829.034
      eclCents: 1_829, interestSuspended: false, suspendedInterestCents: 0,
    })
  })
})

describe("a loan 46 days past due (Stage 2)", () => {
  // Jun paid; Jul (due 31 Jul) and Aug unpaid on 15 Sep 2026.
  const loan = baseLoan({ outstandingPrincipal: 500_000, schedule: schedule([115_000]) })

  it("moves to Stage 2 and provisions lifetime ECL on principal, unpaid instalments and accrued interest", () => {
    const ctx = at("2026-09-15")
    const a = assessLoan(loan, ctx, { stage: 1, stageSince: "2026-05-31", cureStartedOn: null, restructured: false })
    expect(a).toMatchObject({ dpd: 46, suspended: false, staging: { stage: 2, reasons: ["DPD_OVER_SICR_THRESHOLD"], stageSince: "2026-09-15" } })
    const s = buildSnapshot(loan, ctx, a, 0)
    // unpaid raised: Jul+Aug interest 20 000, fees 10 000; accrued R100 x 15/30 = 5 000
    expect(s).toMatchObject({ previousStage: 1, unpaidInterestCents: 20_000, unpaidFeesCents: 10_000, accruedInterestCents: 5_000, eadCents: 535_000, pdBps: 1500, lgdBps: 5000 })
    // 535 000 x 15% x 50% = 40 125
    expect(s.eclCents).toBe(40_125)
  })
})

describe("a loan 92 days past due (Stage 3, interest suspended)", () => {
  // Jun paid; Jul-Oct unpaid on 31 Oct 2026 (Oct falls due that day); R120.00 default charges, R40.00 of it default interest.
  const loan = baseLoan({ outstandingPrincipal: 500_000, chargesOutstanding: 12_000, schedule: schedule([115_000]) })

  it("holds raised interest and default interest in suspense, leaves them out of EAD and provisions at 100% PD", () => {
    const ctx = at("2026-10-31")
    const a = assessLoan(loan, ctx, { stage: 2, stageSince: "2026-09-15", cureStartedOn: null, restructured: false })
    expect(a).toMatchObject({ dpd: 92, suspended: true, staging: { stage: 3, reasons: ["DPD_AT_DEFAULT_THRESHOLD"] } })
    const s = buildSnapshot(loan, ctx, a, 4_000)
    // unpaid raised Jul-Oct: interest 40 000, fees 20 000; no further accrual while suspended
    expect(s).toMatchObject({
      unpaidInterestCents: 40_000, unpaidFeesCents: 20_000, chargesOutstandingCents: 12_000, accruedInterestCents: 0,
      interestSuspended: true, suspensionBasis: "FULL_SUSPENSION", suspendedInterestCents: 40_000, suspendedDefaultInterestCents: 4_000,
      // 500 000 + 40 000 + 20 000 + 12 000 - 40 000 - 4 000
      eadCents: 528_000, pdBps: 10_000, lgdBps: 6000,
    })
    // 528 000 x 100% x 60%
    expect(s.eclCents).toBe(316_800)
  })

  it("never suspends more default interest than the charges owed", () => {
    const ctx = at("2026-10-31")
    const a = assessLoan(loan, ctx, null)
    expect(buildSnapshot(loan, ctx, a, 99_999).suspendedDefaultInterestCents).toBe(12_000)
  })

  it("counts no charges while default charges are not live for the lender", () => {
    const ctx = { ...at("2026-10-31"), chargesLive: false }
    const s = buildSnapshot(loan, ctx, assessLoan(loan, ctx, null), 4_000)
    expect(s).toMatchObject({ chargesOutstandingCents: 0, suspendedDefaultInterestCents: 0, eadCents: 520_000 })
  })
})

describe("parameters", () => {
  it("uses the product's own row over the lender default", () => {
    const ctx = { ...at("2026-10-10"), parameters: [...parameters, { scopeKey: "PRODUCT:p1", stage: 1 as const, pdBps: 400, lgdBps: 3000 }] }
    const loan = baseLoan({ outstandingPrincipal: 200_000, schedule: schedule([115_000, 115_000, 115_000, 115_000]) })
    const s = buildSnapshot(loan, ctx, assessLoan(loan, ctx, null), 0)
    // 203 226 x 4% x 30% = 2 438.712
    expect(s).toMatchObject({ parameterScope: "PRODUCT:p1", eclCents: 2_439 })
  })

  it("refuses to provision at an unset zero when no row covers the stage", () => {
    const ctx = { ...at("2026-10-10"), parameters: parameters.slice(1) }
    const loan = baseLoan({ outstandingPrincipal: 200_000, schedule: schedule([115_000, 115_000, 115_000, 115_000]) })
    expect(() => buildSnapshot(loan, ctx, assessLoan(loan, ctx, null), 0)).toThrow(/stage 1/)
  })
})

describe("a Stage 3 loan with interest still to accrue", () => {
  // 5 Nov 2026: Jul-Oct unpaid (97 days past due), Nov instalment (due 30 Nov) has accrued 5 of 30 days: R100 x 5/30 = 1 666.7 -> 1 667.
  const loan = baseLoan({ outstandingPrincipal: 500_000, chargesOutstanding: 12_000, schedule: schedule([115_000]) })

  it("full suspension: nothing further accrues into exposure, however much has accrued", () => {
    const ctx = at("2026-11-05")
    const s = buildSnapshot(loan, ctx, assessLoan(loan, ctx, null), 4_000)
    expect(s).toMatchObject({ daysPastDue: 97, stage: 3, interestSuspended: true, accruedInterestCents: 0, eadCents: 528_000, eclCents: 316_800 })
  })

  it("net basis (IFRS 9 5.4.1(b)): exposure stays gross and the allowance's share of the raised interest is suspended", () => {
    const ctx = { ...at("2026-11-05"), settings: { ...at("2026-11-05").settings, stage3InterestBasis: "NET_BASIS" as const } }
    const s = buildSnapshot(loan, ctx, assessLoan(loan, ctx, null), 4_000)
    // gross EAD = 500 000 + 40 000 + 20 000 + 12 000 + 1 667 = 573 667 ; ECL = 573 667 x 100% x 60% = 344 200.2 -> 344 200
    expect(s).toMatchObject({ interestSuspended: true, suspensionBasis: "NET_BASIS", accruedInterestCents: 1_667, eadCents: 573_667, eclCents: 344_200 })
    // coverage 344 200 / 573 667: interest 40 000 x that = 24 000.1 -> 24 000 ; default interest 4 000 x that = 2 400.0 -> 2 400
    expect(s.suspendedInterestCents).toBe(24_000)
    expect(s.suspendedDefaultInterestCents).toBe(2_400)
  })

  it("net basis never suspends a Stage 2 loan", () => {
    const ctx = { ...at("2026-09-15"), settings: { ...at("2026-09-15").settings, stage3InterestBasis: "NET_BASIS" as const } }
    const stage2 = baseLoan({ outstandingPrincipal: 500_000, schedule: schedule([115_000]) })
    const s = buildSnapshot(stage2, ctx, assessLoan(stage2, ctx, null), 0)
    expect(s).toMatchObject({ stage: 2, interestSuspended: false, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })
  })
})

describe("a cured Stage 3 loan still in probation (stage differs from the trigger stage)", () => {
  // Everything due is paid by 20 Nov 2026; Stage 3 since 5 Nov, cure started 10 Nov: held in Stage 3 for six months.
  const paid = baseLoan({ outstandingPrincipal: 100_000, schedule: schedule([115_000, 115_000, 115_000, 115_000, 115_000]) })

  it("is provisioned and suspended as Stage 3 although its triggers say Stage 1", () => {
    const ctx = at("2026-11-20")
    const a = assessLoan(paid, ctx, { stage: 3, stageSince: "2026-11-05", cureStartedOn: "2026-11-10", restructured: false })
    expect(a.staging).toMatchObject({ stage: 3, triggerStage: 1, inProbation: true })
    const s = buildSnapshot(paid, ctx, a, 0)
    expect(s).toMatchObject({ stage: 3, triggerStage: 1, previousStage: 3, interestSuspended: true, suspendedInterestCents: 0, pdBps: 10_000, lgdBps: 6000 })
    // nothing raised and unpaid, none accruing while suspended: EAD = principal 100 000 ; ECL = 100 000 x 100% x 60%
    expect(s).toMatchObject({ accruedInterestCents: 0, eadCents: 100_000, eclCents: 60_000 })
  })
})

describe("an asset-finance contract (suspense not journalled)", () => {
  const loan = baseLoan({
    contractType: "INSTALMENT_SALE", status: "DEFAULTED", principal: 1_000_000, outstandingPrincipal: 1_000_000, startDate: new Date("2026-05-01T00:00:00Z"),
    schedule: [{ dueDate: new Date("2026-06-01T00:00:00Z"), principalDue: 0, interestDue: 80_000, feesDue: 0, totalDue: 80_000, totalPaid: 0 }],
  })

  it("is Stage 3 but keeps its interest in the exposure, as the ledger keeps it in income", () => {
    const ctx = at("2026-10-31")
    const a = assessLoan(loan, ctx, null)
    expect(a).toMatchObject({ suspended: false, staging: { stage: 3 } })
    const s = buildSnapshot(loan, ctx, a, 0)
    // 1 000 000 principal + 80 000 raised, unpaid interest ; ECL = 1 080 000 x 100% x 60%
    expect(s).toMatchObject({ interestSuspended: false, suspendedInterestCents: 0, eadCents: 1_080_000, eclCents: 648_000 })
  })
})
