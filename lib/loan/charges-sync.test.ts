import { describe, expect, it, vi } from "vitest"

import { chargesBackdating, chargesEnabled, chargesOutstandingAt, loadChargesReplay } from "./charges-replay"
import { ChargesSyncRefused } from "./charges-verdict"
import { syncLoanCharges } from "./charges-sync"

// Midday SAST so a date never straddles the SAST/UTC day boundary.
const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const ref = { tenantId: "t1", loanId: "loan-1" }

// R2,000 MICRO30 bullet: R100 interest, R69 fee, due 1 Sep. Unpaid, default
// interest over Sep 2..10 is 9 x 200000 x 5% / 30 = R30.00.
function makeLoan(over: Record<string, unknown> = {}) {
  return {
    id: "loan-1",
    tenantId: "t1",
    principal: 200_000,
    interestRatePm: 0.05,
    maturityDate: d("2026-09-01"),
    status: "ACTIVE",
    closedAt: null as Date | null,
    totalPaid: 0,
    outstandingPrincipal: 200_000,
    arrearsAmount: 216_900,
    daysInArrears: 10,
    nextPaymentDate: d("2026-09-01") as Date | null,
    chargesAccrued: 0,
    chargesOutstanding: 0,
    defaultChargesExempt: false,
    // The loan's own agreed fee; the product row deliberately says otherwise.
    monthlyServiceFee: 6_900,
    writeOffAt: null as Date | null,
    defaultChargesExemptEndedAt: null as Date | null,
    product: { code: "MICRO", monthlyServiceFee: 99_999 },
    application: { affordabilityResult: null },
    tenant: {
      config: {
        defaultChargesEnabled: true,
        defaultAdminChargeCents: 8_200,
        defaultAdminPostageCents: 1_500,
        // Long before this loan: no go-live cut-off in play unless a test sets one.
        defaultChargesStartedAt: d("2026-01-01") as Date | null,
        defaultChargesStoppedAt: null as Date | null,
      },
    },
    repaymentSchedule: [{
      id: "row-1",
      dueDate: d("2026-09-01"),
      principalDue: 200_000,
      interestDue: 10_000,
      feesDue: 6_900,
      creditLifePremiumDue: 0,
      totalDue: 216_900,
      totalPaid: 0,
      status: "PENDING",
      paidAt: null as Date | null,
    }],
    ...over,
  }
}

type Receipt = {
  id: string
  amount: number
  receivedAt: Date
  defaultInterestAllocated?: number
  chargeFeesAllocated?: number
}

const frozen = (adminChargeCents: number) => ({ lifecycle: "ISSUED", adminChargeCents })

function makeTx(loan: ReturnType<typeof makeLoan>, opts: {
  receipts?: Receipt[]
  letters?: Array<{ id: string; completedAt: Date; data?: unknown }>
  charges?: Array<{ type: string; day: Date; amount: number; sourceId: string | null }>
} = {}) {
  const tx = {
    loan: {
      findUnique: vi.fn().mockResolvedValue(loan),
      update: vi.fn().mockResolvedValue({}),
    },
    payment: {
      findMany: vi.fn().mockResolvedValue((opts.receipts ?? []).map((r) => ({
        defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...r,
      }))),
      update: vi.fn().mockResolvedValue({}),
    },
    complianceRecord: {
      findMany: vi.fn().mockResolvedValue(opts.letters ?? []),
    },
    loanCharge: {
      findMany: vi.fn().mockResolvedValue(opts.charges ?? []),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    repaymentSchedule: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return tx
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = (tx: ReturnType<typeof makeTx>) => tx as any
const auditActions = (tx: ReturnType<typeof makeTx>) =>
  tx.auditLog.create.mock.calls.map((call) => call[0].data.action)
const loanWrite = (tx: ReturnType<typeof makeTx>) => tx.loan.update.mock.calls[0]?.[0].data

describe("syncLoanCharges — flag off", () => {
  it("writes nothing and reads no receipts when the tenant has charges disabled", async () => {
    const loan = makeLoan({
      tenant: { config: { defaultChargesEnabled: false, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 0 } },
    })
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 3_000, receivedAt: d("2026-09-11") }] })

    expect(await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).toBeNull()
    expect(tx.payment.findMany).not.toHaveBeenCalled()
    expect(tx.payment.update).not.toHaveBeenCalled()
    expect(tx.loan.update).not.toHaveBeenCalled()
    expect(tx.repaymentSchedule.update).not.toHaveBeenCalled()
    expect(tx.loanCharge.deleteMany).not.toHaveBeenCalled()
    expect(tx.loanCharge.createMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("treats a tenant with no config row as disabled", async () => {
    const tx = makeTx(makeLoan({ tenant: { config: null } }))
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).toBeNull()
    expect(await chargesOutstandingAt(asTx(tx), ref, d("2026-09-11"))).toBe(0)
    expect(tx.loan.update).not.toHaveBeenCalled()
  })
})

describe("syncLoanCharges — flag on", () => {
  it("posts default interest on an unpaid overdue loan and audits the change", async () => {
    const tx = makeTx(makeLoan())
    const result = await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })

    expect(result).toMatchObject({ chargesAccrued: 3_000, chargesOutstanding: 3_000, totalPaid: 0, changed: true })
    expect(tx.loanCharge.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", loanId: "loan-1" } })
    expect(tx.loanCharge.createMany).toHaveBeenCalledWith({
      data: [{
        tenantId: "t1", loanId: "loan-1", type: "DEFAULT_INTEREST",
        day: new Date("2026-09-10T00:00:00.000Z"), amount: 3_000, sourceId: null,
      }],
    })
    expect(loanWrite(tx)).toMatchObject({ chargesAccrued: 3_000, chargesOutstanding: 3_000, totalPaid: 0 })
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED"])
  })

  it("audits a re-split between instalments that leaves charges and totalPaid unchanged", async () => {
    // R2,000 over two instalments, no default interest (rate 0). R1,100 was
    // booked instalment by instalment; s126(3) pays both instalments' R50
    // interest and R34.50 fees first, so R69 less principal is realised and
    // the older instalment stays part-unpaid.
    const instalment = (id: string, due: string) => ({
      id, dueDate: d(due), principalDue: 100_000, interestDue: 5_000, feesDue: 3_450,
      creditLifePremiumDue: 0, totalDue: 108_450, totalPaid: 0, status: "PENDING", paidAt: null as Date | null,
    })
    const rows = [
      { ...instalment("row-1", "2026-08-15"), totalPaid: 108_450, status: "PAID", paidAt: d("2026-09-20") },
      { ...instalment("row-2", "2026-09-01"), totalPaid: 1_550, status: "PARTIAL" },
    ]
    const loan = makeLoan({
      interestRatePm: 0, maturityDate: d("2026-09-01"), totalPaid: 110_000, outstandingPrincipal: 100_000,
      arrearsAmount: 106_900, daysInArrears: 25, repaymentSchedule: rows,
    })
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 110_000, receivedAt: d("2026-09-20") }] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })

    expect(loanWrite(tx)).toMatchObject({ totalPaid: 110_000, chargesAccrued: 0, outstandingPrincipal: 106_900, daysInArrears: 42 })
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED"])
    const audit = tx.auditLog.create.mock.calls[0][0].data
    expect(audit.oldValue).toMatchObject({ totalPaid: 110_000, outstandingPrincipal: 100_000, daysInArrears: 25 })
    expect(audit.newValue).toMatchObject({ totalPaid: 110_000, outstandingPrincipal: 106_900, daysInArrears: 42 })
  })

  it("writes but does not audit a DPD-only change, as the DPD cron does", async () => {
    const loan = makeLoan({ interestRatePm: 0, daysInArrears: 24 })
    const tx = makeTx(loan)
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })
    expect(tx.repaymentSchedule.update).not.toHaveBeenCalled()
    expect(loanWrite(tx)).toMatchObject({ daysInArrears: 25, chargesAccrued: 0 })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("audits a status-only change", async () => {
    // Paid in full on the due date: no charges; only the status is stale.
    const loan = makeLoan({ totalPaid: 216_900, outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, nextPaymentDate: null })
    loan.repaymentSchedule[0] = { ...loan.repaymentSchedule[0], totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-01") }
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 216_900, receivedAt: d("2026-09-01") }] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED", "LOAN_STATUS_CHANGED"])
  })

  it("audits a closing-date-only change", async () => {
    // Settled on the due date, but booked closed two days later.
    const loan = makeLoan({
      status: "COMPLETED", closedAt: d("2026-09-03"), totalPaid: 216_900, outstandingPrincipal: 0,
      arrearsAmount: 0, daysInArrears: 0, nextPaymentDate: null,
    })
    loan.repaymentSchedule[0] = { ...loan.repaymentSchedule[0], totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-01") }
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 216_900, receivedAt: d("2026-09-01") }] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })
    expect(loanWrite(tx)).toMatchObject({ closedAt: d("2026-09-01") })
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED", "LOAN_STATUS_CHANGED"])
  })

  it("audits a principal-only change", async () => {
    // Booked principal is stale; instalments, charges and totalPaid agree.
    const loan = makeLoan({ interestRatePm: 0, daysInArrears: 25, outstandingPrincipal: 150_000 })
    const tx = makeTx(loan)
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "LOAN_CHARGES_SYNCED",
      oldValue: { outstandingPrincipal: 150_000, daysInArrears: 25 },
      newValue: { outstandingPrincipal: 200_000, daysInArrears: 25 },
    })
  })

  it("audits a re-split that moves only interest between instalments", async () => {
    // R80 booked to instalment 1's interest and fees; s126(3) pays both
    // instalments' interest instead. No principal, arrears or DPD moves.
    const instalment = (id: string, due: string) => ({
      id, dueDate: d(due), principalDue: 100_000, interestDue: 5_000, feesDue: 3_450,
      creditLifePremiumDue: 0, totalDue: 108_450, totalPaid: 0, status: "PENDING", paidAt: null as Date | null,
    })
    const loan = makeLoan({
      interestRatePm: 0, maturityDate: d("2026-09-01"), totalPaid: 8_000, outstandingPrincipal: 200_000,
      arrearsAmount: 208_900, daysInArrears: 42, nextPaymentDate: d("2026-08-15"),
      repaymentSchedule: [{ ...instalment("row-1", "2026-08-15"), totalPaid: 8_000, status: "PARTIAL" }, instalment("row-2", "2026-09-01")],
    })
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 8_000, receivedAt: d("2026-09-20") }] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-26"), { source: "test" })

    expect(tx.loan.update).not.toHaveBeenCalled()
    expect(tx.repaymentSchedule.update).toHaveBeenCalledTimes(2)
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED"])
  })

  it("is a no-op on a second run with nothing new", async () => {
    const tx = makeTx(makeLoan({ chargesAccrued: 3_000, chargesOutstanding: 3_000 }), {
      charges: [{ type: "DEFAULT_INTEREST", day: new Date("2026-09-10T00:00:00.000Z"), amount: 3_000, sourceId: null }],
    })
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).toMatchObject({ changed: false })
    expect(tx.loanCharge.deleteMany).not.toHaveBeenCalled()
    expect(tx.loan.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("rewrites a stored charge that differs only in a field an implicit join cannot tell apart", async () => {
    const tx = makeTx(makeLoan({ chargesAccrued: 3_000, chargesOutstanding: 3_000 }), {
      charges: [{ type: "DEFAULT_INTEREST", day: new Date("2026-09-10T00:00:00.000Z"), amount: 3_000, sourceId: "" }],
    })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })
    expect(tx.loanCharge.deleteMany).toHaveBeenCalled()
  })

  it("allocates a charge-only receipt to default interest and leaves the schedule unpaid", async () => {
    // The charge-aware writer booked none of it to the schedule.
    const loan = makeLoan({ totalPaid: 0 })
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 3_000, receivedAt: d("2026-09-11") }] })

    const result = await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "p1", tenantId: "t1" },
      data: { defaultInterestAllocated: 3_000, chargeFeesAllocated: 0 },
    })
    expect(result).toMatchObject({ totalPaid: 0, chargesOutstanding: 0, status: "ACTIVE" })
    expect(tx.repaymentSchedule.update).not.toHaveBeenCalled()
  })

  it("fails closed when live receipts exceed charges plus schedule", async () => {
    const tx = makeTx(makeLoan(), {
      receipts: [{ id: "p1", amount: 216_900 + 3_000 + 1, receivedAt: d("2026-09-11") }],
    })
    await expect(syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).rejects.toThrow(/unallocated/)
    expect(tx.loan.update).not.toHaveBeenCalled()
  })

  it("completes the loan only when the schedule AND the charges are paid", async () => {
    // The writer booked R2,169 as a full settlement, but R30 of default
    // interest takes the first cut, so R30 of the schedule is still unpaid.
    const schedulePaid = makeLoan({ status: "COMPLETED", closedAt: d("2026-09-11"), totalPaid: 216_900 })
    schedulePaid.repaymentSchedule[0].totalPaid = 216_900
    schedulePaid.repaymentSchedule[0].status = "PAID"
    // A normal sync refuses to take that back and re-open the loan (S1)...
    const refused = makeTx(schedulePaid, { receipts: [{ id: "p1", amount: 216_900, receivedAt: d("2026-09-11") }] })
    await expect(syncLoanCharges(asTx(refused), ref, d("2026-09-11"), { source: "test" })).rejects.toBeInstanceOf(ChargesSyncRefused)
    expect(refused.loan.update).not.toHaveBeenCalled()
    expect(refused.payment.update).not.toHaveBeenCalled()
    expect(refused.loanCharge.createMany).not.toHaveBeenCalled()
    // ...which only a reversal may do.
    const short = makeTx(schedulePaid, { receipts: [{ id: "p1", amount: 216_900, receivedAt: d("2026-09-11") }] })
    expect(await syncLoanCharges(asTx(short), ref, d("2026-09-11"), { source: "test" }, { mode: "reversal" }))
      .toMatchObject({ status: "ACTIVE", closedAt: null, chargesOutstanding: 0, totalPaid: 213_900 })
    expect(auditActions(short)).toContain("LOAN_STATUS_CHANGED")

    // A notice confirmed after the client settled is not charged: no default
    // was open, so the loan stays settled.
    const lateLetter = makeTx(makeLoan(), {
      receipts: [{ id: "p1", amount: 219_900, receivedAt: d("2026-09-11") }],
      letters: [{ id: "s129-1", completedAt: d("2026-09-12"), data: frozen(9_700) }],
    })
    expect(await syncLoanCharges(asTx(lateLetter), ref, d("2026-09-13"), { source: "test" }))
      .toMatchObject({ status: "COMPLETED", chargesOutstanding: 0, totalPaid: 216_900 })

    const full = makeTx(makeLoan(), { receipts: [{ id: "p1", amount: 219_900, receivedAt: d("2026-09-11") }] })
    expect(await syncLoanCharges(asTx(full), ref, d("2026-09-11"), { source: "test" }))
      .toMatchObject({ status: "COMPLETED", closedAt: d("2026-09-11"), chargesOutstanding: 0, totalPaid: 216_900 })
    expect(full.repaymentSchedule.update).toHaveBeenCalledWith({
      where: { id: "row-1", tenantId: "t1" },
      data: { totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-11") },
    })
  })

  it("dates a newly paid instalment by the receipt that completed it, not the sync", async () => {
    // p1: R10 default interest, R100 interest, R69 fees, R821 principal. p2:
    // Sep 5..7 on R1,179 overdue principal = R5.90, then the R1,179.
    const tx = makeTx(makeLoan(), { receipts: [
      { id: "p1", amount: 100_000, receivedAt: d("2026-09-05") },
      { id: "p2", amount: 118_490, receivedAt: d("2026-09-08") },
    ] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-12"), { source: "test" })
    expect(tx.repaymentSchedule.update).toHaveBeenCalledWith({
      where: { id: "row-1", tenantId: "t1" },
      data: { totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-08") },
    })
  })

  it("re-dates a paid instalment whose completing receipt was reversed, though its totalPaid is unchanged", async () => {
    // Booked PAID on 9 Sep by a receipt since reversed; the live receipt of
    // 5 Sep (R10 default interest, then the R2,169) is what completed it.
    const loan = makeLoan({
      status: "COMPLETED", closedAt: d("2026-09-05"), totalPaid: 216_900, outstandingPrincipal: 0,
      arrearsAmount: 0, daysInArrears: 0, nextPaymentDate: null, chargesAccrued: 1_000,
    })
    loan.repaymentSchedule[0] = { ...loan.repaymentSchedule[0], totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-09") }
    const tx = makeTx(loan, {
      receipts: [{ id: "p1", amount: 217_900, receivedAt: d("2026-09-05"), defaultInterestAllocated: 1_000 }],
      charges: [{ type: "DEFAULT_INTEREST", day: new Date("2026-09-04T00:00:00.000Z"), amount: 1_000, sourceId: null }],
    })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-12"), { source: "test" })
    expect(tx.repaymentSchedule.update).toHaveBeenCalledWith({
      where: { id: "row-1", tenantId: "t1" },
      data: { totalPaid: 216_900, status: "PAID", paidAt: d("2026-09-05") },
    })
    expect(auditActions(tx)).toEqual(["LOAN_CHARGES_SYNCED"])
  })

  it("re-opens a completed loan once a reversal leaves charges unpaid", async () => {
    // After the reversal only p1 is live; p2 (the settling receipt) is gone.
    const loan = makeLoan({ status: "COMPLETED", closedAt: d("2026-09-11"), totalPaid: 100_000 })
    loan.repaymentSchedule[0].totalPaid = 100_000
    const tx = makeTx(loan, { receipts: [{ id: "p1", amount: 100_000, receivedAt: d("2026-09-05"), defaultInterestAllocated: 0 }] })

    const result = await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" }, { mode: "reversal" })

    expect(result?.status).toBe("ACTIVE")
    expect(result?.closedAt).toBeNull()
    expect(result?.chargesOutstanding).toBeGreaterThan(0)
    expect(loanWrite(tx)).toMatchObject({ status: "ACTIVE", closedAt: null })
  })

  it("charges less default interest when the same receipt is dated earlier", async () => {
    const late = makeTx(makeLoan(), { receipts: [{ id: "p1", amount: 100_000, receivedAt: d("2026-09-10") }] })
    const early = makeTx(makeLoan(), { receipts: [{ id: "p1", amount: 100_000, receivedAt: d("2026-09-03") }] })
    const lateResult = await syncLoanCharges(asTx(late), ref, d("2026-09-11"), { source: "test" })
    const earlyResult = await syncLoanCharges(asTx(early), ref, d("2026-09-11"), { source: "test" })
    expect(earlyResult!.chargesAccrued).toBeLessThan(lateResult!.chargesAccrued)
    expect(earlyResult!.totalPaid).toBeGreaterThan(lateResult!.totalPaid)
  })

  it("posts each issued Section 129 notice's frozen admin charge, from the issue date", async () => {
    const tx = makeTx(makeLoan(), { letters: [{ id: "s129-1", completedAt: d("2026-09-05"), data: frozen(9_700) }] })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })

    expect(tx.complianceRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "t1",
        type: "SECTION_129_NOTICE",
        referenceId: "loan-1",
        status: "COMPLETED",
        data: { path: ["lifecycle"], equals: "ISSUED" },
      }),
    }))
    const rows = tx.loanCharge.createMany.mock.calls[0][0].data
    expect(rows).toContainEqual(expect.objectContaining({
      type: "DEFAULT_ADMIN", amount: 9_700, sourceId: "s129-1", day: new Date("2026-09-05T00:00:00.000Z"),
    }))
  })

  it("charges the post-maturity service fee agreed at booking, never the product's current fee", async () => {
    const tx = makeTx(makeLoan({ monthlyServiceFee: 5_000 }))
    await syncLoanCharges(asTx(tx), ref, d("2026-10-02"), { source: "test" })
    const fees = tx.loanCharge.createMany.mock.calls[0][0].data
      .filter((row: { type: string }) => row.type === "SERVICE_FEE")
    expect(fees).toEqual([expect.objectContaining({ amount: 5_000, day: new Date("2026-10-01T00:00:00.000Z") })])
  })

  it("falls back to the approval snapshot, else the product, for a loan booked without the fee column", async () => {
    const serviceFee = async (over: Record<string, unknown>) => {
      const tx = makeTx(makeLoan({ monthlyServiceFee: null, ...over }))
      await syncLoanCharges(asTx(tx), ref, d("2026-10-02"), { source: "test" })
      return tx.loanCharge.createMany.mock.calls[0][0].data
        .filter((row: { type: string }) => row.type === "SERVICE_FEE")
        .map((row: { amount: number }) => row.amount)
    }
    expect(await serviceFee({
      application: { affordabilityResult: { approval: { inputs: { monthlyServiceFeeCents: 4_500 } } } },
    })).toEqual([4_500])
    expect(await serviceFee({})).toEqual([99_999])
  })

  it("charges a letter at the amount frozen on its issuance, not today's tenant setting", async () => {
    const tx = makeTx(makeLoan(), {
      letters: [{ id: "s129-frozen", completedAt: d("2026-09-05"), data: frozen(7_000) }],
    })
    await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })
    const letters = tx.loanCharge.createMany.mock.calls[0][0].data
      .filter((row: { type: string }) => row.type === "DEFAULT_ADMIN")
    expect(letters.map((row: { sourceId: string; amount: number }) => [row.sourceId, row.amount]))
      .toEqual([["s129-frozen", 7_000]])
  })

  it("refuses a notice with no frozen amount rather than pricing it at today's setting", async () => {
    const tx = makeTx(makeLoan(), {
      letters: [{ id: "s129-legacy", completedAt: d("2026-09-06"), data: { lifecycle: "ISSUED" } }],
    })
    await expect(syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).rejects.toThrow(/s129-legacy has no frozen admin charge/)
    expect(tx.loan.update).not.toHaveBeenCalled()
  })

  it("stops charging a written-off loan at its write-off date", async () => {
    const tx = makeTx(makeLoan({ status: "WRITTEN_OFF", writeOffAt: d("2026-09-06") }))
    const result = await syncLoanCharges(asTx(tx), ref, d("2026-10-11"), { source: "test" })
    // Sep 2..5 only: 4 x R10/day... 4 x 333.33.
    expect(result?.chargesAccrued).toBe(1_333)
    expect(result?.status).toBe("WRITTEN_OFF")
  })

  it("stops charging a cancelled loan at its closing date", async () => {
    const tx = makeTx(makeLoan({ status: "CANCELLED", closedAt: d("2026-09-04") }))
    expect((await syncLoanCharges(asTx(tx), ref, d("2026-10-11"), { source: "test" }))?.chargesAccrued).toBe(667)
  })

  it("never moves a written-off or cancelled loan's status, even once everything is paid", async () => {
    for (const status of ["WRITTEN_OFF", "CANCELLED"]) {
      const tx = makeTx(makeLoan({ status, writeOffAt: d("2026-09-06"), closedAt: d("2026-09-06") }), {
        receipts: [{ id: "p1", amount: 216_900 + 1_333, receivedAt: d("2026-09-11") }],
      })
      expect((await syncLoanCharges(asTx(tx), ref, d("2026-09-12"), { source: "test" }))?.status).toBe(status)
    }
  })

  it("refuses a closed status that has lost its date instead of charging it as open", async () => {
    for (const over of [
      { status: "WRITTEN_OFF", writeOffAt: null },
      { status: "COMPLETED", closedAt: null },
      { status: "CANCELLED", closedAt: null },
    ]) {
      const tx = makeTx(makeLoan(over))
      await expect(syncLoanCharges(asTx(tx), ref, d("2026-10-11"), { source: "test" })).rejects.toThrow(/refusing to derive its charges/)
      expect(tx.loan.update).not.toHaveBeenCalled()
    }
  })

  it("records the fallback fee on a loan booked without one, audited, so a product edit cannot move it", async () => {
    const tx = makeTx(makeLoan({ monthlyServiceFee: null }))
    await syncLoanCharges(asTx(tx), ref, d("2026-10-02"), { source: "cron" })
    expect(tx.loan.update).toHaveBeenCalledWith({
      where: { id: "loan-1", tenantId: "t1" }, data: { monthlyServiceFee: 99_999 },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "LOAN_SERVICE_FEE_RECORDED", oldValue: { monthlyServiceFee: null },
      newValue: { monthlyServiceFee: 99_999, source: "cron" },
    }) })
  })

  it("dates a settled loan's closing at its last receipt, not the earlier date a writer stamped", async () => {
    const loan = makeLoan({ status: "COMPLETED", closedAt: d("2026-09-10"), totalPaid: 216_900, chargesAccrued: 0 })
    const tx = makeTx(loan, {
      receipts: [
        { id: "p1", amount: 100_000, receivedAt: d("2026-09-01") },
        { id: "p2", amount: 116_900, receivedAt: d("2026-09-01") },
      ],
    })
    // Paid in full on the due date: nothing accrued, so only the date moves.
    loan.closedAt = d("2026-08-30")
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" })).toMatchObject({ status: "COMPLETED", closedAt: d("2026-09-01") })
    expect(auditActions(tx)).toContain("LOAN_STATUS_CHANGED")
  })

  it("decides completion from a replay not bounded by the closing date a writer stamped", async () => {
    // A writer closed it on 5 Sep, but the settling receipt is dated 11 Sep and
    // pays the R30 of default interest to the 10th first.
    const tx = makeTx(makeLoan({ status: "COMPLETED", closedAt: d("2026-09-05"), totalPaid: 216_900 }), {
      receipts: [{ id: "p1", amount: 219_900, receivedAt: d("2026-09-11") }],
    })
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-09-12"), { source: "test" }))
      .toMatchObject({ status: "COMPLETED", closedAt: d("2026-09-11"), chargesAccrued: 3_000, totalPaid: 216_900 })
  })

  it("charges are never live once stopped, whatever the flag says", () => {
    const config = { defaultChargesEnabled: true, defaultChargesStartedAt: d("2026-01-01"), defaultChargesStoppedAt: null as Date | null }
    expect(chargesEnabled({ tenant: { config } })).toBe(true)
    expect(chargesEnabled({ tenant: { config: { ...config, defaultChargesStoppedAt: d("2026-09-20") } } })).toBe(false)
  })

  it("derives nothing for a tenant whose charges were stopped", async () => {
    const stopped = makeLoan({ tenant: { config: { ...makeLoan().tenant.config, defaultChargesStoppedAt: d("2026-09-20") } } })
    const tx = makeTx(stopped)
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-10-11"), { source: "test" })).toBeNull()
    expect(tx.loan.update).not.toHaveBeenCalled()
    expect(tx.loanCharge.deleteMany).not.toHaveBeenCalled()
  })

  it("keeps charging a loan pending write-off", async () => {
    const tx = makeTx(makeLoan({ status: "PENDING_WRITE_OFF" }))
    expect((await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" }))?.chargesAccrued).toBe(3_000)
  })

  it("does not back-charge the period a lifted exemption covered", async () => {
    const tx = makeTx(makeLoan({ defaultChargesExemptEndedAt: d("2026-09-08") }))
    // Sep 8..10 only.
    expect((await syncLoanCharges(asTx(tx), ref, d("2026-09-11"), { source: "test" }))?.chargesAccrued).toBe(1_000)
  })
})

describe("chargesOutstandingAt", () => {
  it("prices outstanding charges at the value date", async () => {
    const tx = makeTx(makeLoan())
    expect(await chargesOutstandingAt(asTx(tx), ref, d("2026-09-11"))).toBe(3_000)
    expect(tx.loan.update).not.toHaveBeenCalled()
  })

  it("is 0 when the flag is off", async () => {
    const tx = makeTx(makeLoan({
      tenant: { config: { defaultChargesEnabled: false, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 0 } },
    }))
    expect(await chargesOutstandingAt(asTx(tx), ref, d("2026-09-11"))).toBe(0)
  })
})

describe("chargesBackdating", () => {
  const replayFor = async (loan: ReturnType<typeof makeLoan>, asOf: Date) =>
    (await loadChargesReplay(asTx(makeTx(loan)), ref, asOf))!

  it("measures the default interest a back-dated receipt erases against pricing it today", async () => {
    // Dated 11 Sep the R2,169 receipt first pays R30 of default interest; dated
    // 2 Sep it clears the loan before a single day of default interest accrues.
    const replay = await replayFor(makeLoan(), d("2026-09-11"))
    expect(chargesBackdating(replay, { amount: 216_900, receivedAt: d("2026-09-02") }, d("2026-09-11")))
      .toEqual({ rebateCents: 3_000, accruedAtCaptureCents: 3_000 })
  })

  it("is zero for a receipt dated today", async () => {
    const replay = await replayFor(makeLoan(), d("2026-09-11"))
    expect(chargesBackdating(replay, { amount: 216_900, receivedAt: d("2026-09-11") }, d("2026-09-11")).rebateCents).toBe(0)
  })

  it("prices the back-charges a receipt dated before go-live removes", async () => {
    // Go-live 24 Sep, overdue since 1 Sep: charged from 2 Sep (R80 by the 26th).
    // Dated 23 Sep, the full receipt makes the loan paid up at go-live, so NONE
    // of that is charged: the date erases all R80, not just Sep 23..25.
    const loan = makeLoan({
      tenant: { config: { defaultChargesEnabled: true, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 0, defaultChargesStartedAt: d("2026-09-24") } },
    })
    const replay = await replayFor(loan, d("2026-09-26"))
    expect(chargesBackdating(replay, { amount: 216_900, receivedAt: d("2026-09-23") }, d("2026-09-26")))
      .toEqual({ rebateCents: 8_000, accruedAtCaptureCents: 8_000 })
  })
})

describe("go-live cut-off (TenantConfig.defaultChargesStartedAt)", () => {
  const goLive = d("2026-09-26")
  const liveFrom = (over: Record<string, unknown> = {}) => makeLoan({
    tenant: { config: { defaultChargesEnabled: true, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 0, defaultChargesStartedAt: goLive } },
    ...over,
  })

  it("posts nothing while the flag is on but go-live has not been set", async () => {
    const tx = makeTx(makeLoan({
      tenant: { config: { defaultChargesEnabled: true, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 0, defaultChargesStartedAt: null } },
    }))
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" })).toBeNull()
    expect(tx.loan.update).not.toHaveBeenCalled()
  })

  it("never back-charges a loan paid up before go-live, however late it was paid", async () => {
    // Nine days late on 10 Sep; without the cut-off R30 of default interest.
    const tx = makeTx(liveFrom({ status: "COMPLETED", closedAt: d("2026-09-10"), totalPaid: 216_900 }), {
      receipts: [{ id: "p1", amount: 216_900, receivedAt: d("2026-09-10") }],
    })
    const result = await syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" })
    expect(result).toMatchObject({ chargesAccrued: 0, totalPaid: 216_900, status: "COMPLETED" })
    expect(tx.payment.update).not.toHaveBeenCalled()
  })

  it("never back-charges a loan settled on go-live day itself", async () => {
    const tx = makeTx(liveFrom({ status: "COMPLETED", closedAt: goLive, totalPaid: 216_900 }), {
      receipts: [{ id: "p1", amount: 216_900, receivedAt: goLive }],
    })
    expect(await syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" }))
      .toMatchObject({ chargesAccrued: 0, totalPaid: 216_900, status: "COMPLETED" })
  })

  it("back-charges the default still open at go-live from the day after its due date, receipts in between included", async () => {
    // R1,000 on 10 Sep left the bullet overdue at go-live: charges run from
    // Sep 2, so the 10 Sep receipt first pays Sep 2..9 interest (R26.67).
    const tx = makeTx(liveFrom({ totalPaid: 100_000 }), {
      receipts: [{ id: "p1", amount: 100_000, receivedAt: d("2026-09-10") }],
    })
    // Moving booked schedule money onto charges needs the back-fill's acceptance.
    await expect(syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" })).rejects.toBeInstanceOf(ChargesSyncRefused)
    await syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" }, { mode: "backfill", accepted: new Set(["loan-1"]) })
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "p1", tenantId: "t1" },
      data: { defaultInterestAllocated: 2_667, chargeFeesAllocated: 0 },
    })
    const rows = tx.loanCharge.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({ type: "DEFAULT_INTEREST", day: new Date("2026-09-30T00:00:00.000Z") })
  })

  it("does not back-charge lateness cured before go-live on an earlier instalment", async () => {
    const two = liveFrom()
    two.repaymentSchedule = [
      { ...two.repaymentSchedule[0], id: "row-1", dueDate: d("2026-08-01"), principalDue: 100_000, interestDue: 5_000, feesDue: 0, totalDue: 105_000 },
      { ...two.repaymentSchedule[0], id: "row-2", dueDate: d("2026-09-01"), principalDue: 100_000, interestDue: 5_000, feesDue: 0, totalDue: 105_000 },
    ]
    // Instalment 1 paid 20 days late (21 Aug); instalment 2 still overdue at go-live.
    const tx = makeTx(two, { receipts: [{ id: "p1", amount: 105_000, receivedAt: d("2026-08-21") }] })
    const result = await syncLoanCharges(asTx(tx), ref, d("2026-09-27"), { source: "test" })
    // Only Sep 2..26 on instalment 2's R1,000: 25 x 100000 x 5% / 30 = R41.67.
    expect(result?.chargesAccrued).toBe(4_167)
    expect(tx.payment.update).not.toHaveBeenCalled()
  })
})

describe("per-loan exemption", () => {
  it("strips every charge and split from an exempt loan and allocates schedule-first", async () => {
    const loan = makeLoan({ defaultChargesExempt: true, chargesAccrued: 3_000, chargesOutstanding: 0, totalPaid: 0 })
    const tx = makeTx(loan, {
      receipts: [{ id: "p1", amount: 3_000, receivedAt: d("2026-09-11"), defaultInterestAllocated: 3_000 }],
      charges: [{ type: "DEFAULT_INTEREST", day: new Date("2026-09-10T00:00:00.000Z"), amount: 3_000, sourceId: null }],
      letters: [{ id: "s129-1", completedAt: d("2026-09-05"), data: frozen(9_700) }],
    })
    const result = await syncLoanCharges(asTx(tx), ref, d("2026-10-05"), { source: "test" })
    expect(result).toMatchObject({ chargesAccrued: 0, chargesOutstanding: 0, totalPaid: 3_000 })
    expect(tx.loanCharge.deleteMany).toHaveBeenCalled()
    expect(tx.loanCharge.createMany).not.toHaveBeenCalled()
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "p1", tenantId: "t1" },
      data: { defaultInterestAllocated: 0, chargeFeesAllocated: 0 },
    })
  })
})
