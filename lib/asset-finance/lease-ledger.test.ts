import { describe, expect, it } from "vitest"
import { BookingAmountError } from "./booking-plan"
import { dbDate } from "./dates"
import { planLeaseBooking } from "./lease-ledger"
import { priceLease, type LeasePricingInput } from "./lease-pricing"
import { dueDateInstant } from "./schedule-records"

// Synthetic FML: R1 500 000 ex VAT TLB, R300 000 residual, 36 rentals in
// arrears at 12.25% with 8% escalation, R4 500 maintenance escalating 6.5%.
const LEASE: LeasePricingInput = {
  cashPriceExclVatCents: 150_000_000,
  residualCents: 30_000_000,
  periods: 36,
  rentalTiming: "ARREARS",
  escalationRate: "0.08",
  startDate: "2026-11-01",
  ratePath: [{ effectiveDate: "2026-11-01", annualRate: 0.1225 }],
  maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065" },
  vatRateTenThousandths: 1500,
}

describe("planLeaseBooking: the lease ledger mapping (DESIGN.md slice 3)", () => {
  const lease = priceLease(LEASE)
  const plan = planLeaseBooking({ lease, startDate: LEASE.startDate, vatRate: "0.1500", payoutCents: 172_500_000 })

  it("one schedule row per rental: the whole rental incl. maintenance and VAT is principalDue; nothing is interest or fees", () => {
    expect(plan.records).toHaveLength(36)
    plan.records.forEach((r, i) => {
      const p = lease.periods[i]
      expect(r).toEqual({
        installmentNo: i + 1, dueDate: dueDateInstant(p.dueDate),
        principalDue: p.totalCents, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: p.totalCents,
      })
      expect(plan.openingBalances[i]).toBe(p.row.openingBalanceCents)
    })
  })

  it("loan totals reconcile with the rows: principal = totalRepayable = Σ rentals incl. VAT; no interest, no balloon", () => {
    const sum = plan.records.reduce((t, r) => t + r.totalDue, 0)
    expect(sum).toBe(lease.totalCents)
    expect(plan.principal).toBe(sum)
    expect(plan.totalRepayable).toBe(sum)
    expect(plan.totalInterest).toBe(0)
    expect(plan.baseInstalmentCents).toBe(lease.baseRentalCents)
    expect(plan.startDate).toEqual(dueDateInstant("2026-11-01"))
    expect(plan.nextPaymentDate).toEqual(dueDateInstant("2026-12-01"))
    expect(plan.maturityDate).toEqual(dueDateInstant("2029-11-01"))
  })

  it("a LeaseRental per row carries the split the tax invoice will print", () => {
    expect(plan.rentals).toHaveLength(36)
    plan.rentals.forEach((r, i) => {
      const p = lease.periods[i]
      expect(r).toEqual({
        periodNo: i + 1, dueDate: dbDate(p.dueDate), rentalExclVatCents: p.rentalExclVatCents,
        maintenanceExclVatCents: p.maintenanceExclVatCents, vatCents: p.vatCents, totalCents: p.totalCents, vatRate: "0.1500",
      })
      expect(r.totalCents).toBe(plan.records[i].totalDue)
    })
  })

  it("an ADVANCE lease's first rental is due at commencement", () => {
    const advance = priceLease({ ...LEASE, rentalTiming: "ADVANCE" })
    const p = planLeaseBooking({ lease: advance, startDate: LEASE.startDate, vatRate: "0.1500", payoutCents: 1 })
    expect(p.nextPaymentDate).toEqual(dueDateInstant("2026-11-01"))
    expect(p.records[0].dueDate).toEqual(p.startDate)
  })

  it("refuses a total that does not fit the INT4 money columns", () => {
    const big = priceLease({ ...LEASE, cashPriceExclVatCents: 2_100_000_000, residualCents: 0, periods: 2, maintenance: null })
    expect(() => planLeaseBooking({ lease: big, startDate: LEASE.startDate, vatRate: "0.1500", payoutCents: 1 })).toThrow(BookingAmountError)
  })
})
