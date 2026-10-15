import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { leaseCapitalRows } from "./lease-reprice"
import { priceLease } from "./lease-pricing"
import { planLeaseBooking } from "./lease-ledger"
import { storedScheduleForReprice } from "./stored-schedule"
import type { StoredScheduleRow } from "./stored-schedule"

// A booked 12-month lease (arrears, 11.75%, R300k residual) as booking stores it.
const lease = priceLease({
  cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 12, rentalTiming: "ARREARS", escalationRate: "0",
  startDate: "2027-01-15", ratePath: [{ effectiveDate: "2027-01-15", annualRate: 0.1175 }], maintenance: null, vatRateTenThousandths: 1500,
})
const plan = planLeaseBooking({ lease, startDate: "2027-01-15", vatRate: "0.1500", payoutCents: 1 })
const stored: StoredScheduleRow[] = plan.records.map((r, i) => ({
  ...r, id: `s${i + 1}`, status: "PENDING", totalPaid: 0, assetFinanceOpeningBalanceCents: plan.openingBalances[i],
}))
const rentals = plan.rentals.map((r, i) => ({
  id: `r${i + 1}`, periodNo: r.periodNo, scheduleId: `s${i + 1}`, rentalExclVatCents: r.rentalExclVatCents,
  maintenanceExclVatCents: r.maintenanceExclVatCents, vatRate: new Prisma.Decimal(r.vatRate), taxInvoiceId: null,
}))
const tx = (rows = rentals, residual = 30_000_000) => ({
  assetFinanceDeal: { findFirst: async () => ({ balloonCents: residual, rentalTiming: "ARREARS" }) },
  leaseRental: { findMany: async () => rows },
}) as never

describe("leaseCapitalRows: the capital view a lease reprices on", () => {
  it("rebuilds the solver rows exactly: stored-schedule accepts them and lands on the residual", async () => {
    const view = await leaseCapitalRows(tx(), "t1", "l1", stored)
    if ("error" in view) throw new Error(view.error)
    view.rows.forEach((row, i) => {
      const solver = lease.periods[i].row
      expect(row.totalDue).toBe(solver.totalCents)
      expect(row.interestDue).toBe(Math.min(solver.interestCents, solver.totalCents - solver.balloonCents))
    })
    const schedule = storedScheduleForReprice({
      stored: view.rows, balloonCents: view.residualCents, recordedBaseCents: lease.baseRentalCents,
      ratePath: [{ effectiveDate: "2027-01-15", annualRate: 0.1175 }], startDate: "2027-01-15",
    })
    expect("error" in schedule).toBe(false)
    if (!("error" in schedule)) expect(schedule.capitalOutstandingCents).toBe(150_000_000)
  })

  it("refuses a schedule its rentals do not match", async () => {
    expect(await leaseCapitalRows(tx(rentals.slice(1)), "t1", "l1", stored)).toEqual({ error: "unsupported_schedule" })
    const swapped = rentals.map((r, i) => (i === 3 ? { ...r, scheduleId: "s9" } : r))
    expect(await leaseCapitalRows(tx(swapped), "t1", "l1", stored)).toEqual({ error: "unsupported_schedule" })
  })

  it("a wrong residual cannot rebuild the schedule (the last row would not close)", async () => {
    const view = await leaseCapitalRows(tx(rentals, 29_000_000), "t1", "l1", stored)
    if ("error" in view) throw new Error(view.error)
    const schedule = storedScheduleForReprice({
      stored: view.rows, balloonCents: view.residualCents, recordedBaseCents: lease.baseRentalCents,
      ratePath: [{ effectiveDate: "2027-01-15", annualRate: 0.1175 }], startDate: "2027-01-15",
    })
    expect(schedule).toEqual({ error: "unsupported_schedule" })
  })
})
