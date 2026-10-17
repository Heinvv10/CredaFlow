import { describe, expect, it, vi } from "vitest"
import { loadChargesReplay } from "./charges-replay"
import { recoveryChargePauses } from "./recovery-pauses"

const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)

describe("recoveryChargePauses", () => {
  it("is undefined with no recovery or no started freeze, so an engine without pauses is unchanged", () => {
    expect(recoveryChargePauses(undefined)).toBeUndefined()
    expect(recoveryChargePauses([])).toBeUndefined()
    expect(recoveryChargePauses([{ chargesFrozenFrom: null, chargesFrozenUntil: null }])).toBeUndefined()
  })

  it("maps a fixed freeze to its inclusive window", () => {
    const from = new Date("2026-09-04T00:00:00Z")
    const until = new Date("2026-09-18T00:00:00Z")
    expect(recoveryChargePauses([{ chargesFrozenFrom: from, chargesFrozenUntil: until }])).toEqual([{ from, until }])
  })

  it("keeps a freeze whose end is not fixed yet open-ended (an NCA recovery before its final notice)", () => {
    const pauses = recoveryChargePauses([{ chargesFrozenFrom: new Date("2026-09-04T00:00:00Z"), chargesFrozenUntil: null }])
    expect(pauses).toHaveLength(1)
    expect(pauses![0].until.getUTCFullYear()).toBe(9999)
  })
})

// R2,000 NCA bullet due 1 Sep, 5% pm: R30.00 default interest to the 11th, R3.33 a day (as charges-replay.pauses.test.ts).
const loan = (recoveries: unknown) => ({
  principal: 200_000, interestRatePm: 0.05, ncaRegime: "NCA", maturityDate: d("2026-09-01"), status: "ACTIVE",
  closedAt: null, writeOffAt: null, defaultChargesExempt: false, defaultChargesExemptEndedAt: null,
  monthlyServiceFee: 6_900, nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null,
  product: { code: "MICRO", monthlyServiceFee: 6_900 }, contractRates: [], recoveries,
  tenant: { config: { defaultChargesEnabled: true, defaultChargesStartedAt: d("2026-01-01"), defaultChargesStoppedAt: null } },
  repaymentSchedule: [{
    dueDate: d("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900,
    creditLifePremiumDue: 0, totalDue: 216_900,
  }],
})
const txOf = (recoveries: unknown) => ({
  loan: { findUnique: vi.fn().mockResolvedValue(loan(recoveries)) },
  payment: { findMany: vi.fn().mockResolvedValue([]) },
  complianceRecord: { findMany: vi.fn().mockResolvedValue([]) },
}) as never

describe("loadChargesReplay — the loan's recovery freeze", () => {
  const ref = { tenantId: "t1", loanId: "loan-1" }

  it("accrues nothing on the frozen days and resumes after the deadline", async () => {
    const frozen = [{ chargesFrozenFrom: new Date("2026-09-04T00:00:00Z"), chargesFrozenUntil: new Date("2026-09-06T00:00:00Z") }]
    const plain = (await loadChargesReplay(txOf([]), ref, d("2026-09-11")))!
    const paused = (await loadChargesReplay(txOf(frozen), ref, d("2026-09-11")))!
    expect(plain.result.interestAccrued).toBe(3_000)
    expect(paused.result.interestAccrued).toBe(2_000)
    expect(paused.replayAt(d("2026-09-11")).interestAccrued).toBe(2_000)
    // Before the freeze starts nothing differs; after it ends the days accrue again.
    expect(paused.replayAt(d("2026-09-03")).interestAccrued).toBe(plain.replayAt(d("2026-09-03")).interestAccrued)
    expect(paused.replayAt(d("2026-09-12")).interestAccrued - paused.replayAt(d("2026-09-11")).interestAccrued).toBe(333)
  })

  it("adds the explicit pauses of a caller to the recovery's", async () => {
    const frozen = [{ chargesFrozenFrom: new Date("2026-09-04T00:00:00Z"), chargesFrozenUntil: new Date("2026-09-06T00:00:00Z") }]
    const both = (await loadChargesReplay(txOf(frozen), ref, d("2026-09-11"), { pauses: [{ from: d("2026-09-08"), until: d("2026-09-08") }] }))!
    expect(both.result.interestAccrued).toBe(1_667) // 9 accruing days less 3 frozen and 1 paused: 5 x 333.33
  })
})


describe("standalone surrender freezes use the same replay boundary", () => {
  it("freezes charges without any Recovery record", async () => {
    const frozen = [{ chargesFrozenFrom: new Date("2026-09-04T00:00:00Z"), chargesFrozenUntil: new Date("2026-09-06T00:00:00Z") }]
    const tx = {
      loan: { findUnique: vi.fn().mockResolvedValue({ ...loan([]), surrenderRequests: frozen }) },
      payment: { findMany: vi.fn().mockResolvedValue([]) }, complianceRecord: { findMany: vi.fn().mockResolvedValue([]) },
    } as never
    expect((await loadChargesReplay(tx, { tenantId: "t1", loanId: "loan-1" }, d("2026-09-11")))!.result.interestAccrued).toBe(2_000)
  })
})
