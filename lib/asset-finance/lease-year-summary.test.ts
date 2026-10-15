import { describe, expect, it } from "vitest"
import { leaseYearSummary } from "./lease-year-summary"
import type { LeaseScheduleRow } from "./lease-view"

const row = (periodNo: number, rental: number, maintenance: number): LeaseScheduleRow => {
  const vatCents = Math.round((rental + maintenance) * 0.15)
  return { periodNo, dueDate: `2030-${String(((periodNo - 1) % 12) + 1).padStart(2, "0")}-01`, rentalExclVatCents: rental, maintenanceExclVatCents: maintenance, vatCents, totalCents: rental + maintenance + vatCents }
}

describe("leaseYearSummary", () => {
  it("groups rentals by lease year and reports the escalated monthly amounts", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row(i + 1, 100_000, 10_000)),
      ...Array.from({ length: 12 }, (_, i) => row(i + 13, 108_000, 10_600)),
      row(25, 116_640, 11_236),
    ]
    const years = leaseYearSummary(rows)
    expect(years.map((y) => [y.year, y.rentals, y.rentalExclVatCents, y.maintenanceExclVatCents])).toEqual([
      [1, 12, 100_000, 10_000], [2, 12, 108_000, 10_600], [3, 1, 116_640, 11_236],
    ])
    expect(years[0].totalCents).toBe(126_500)
    expect(years[0].yearTotalCents).toBe(126_500 * 12)
  })

  it("sums the rows of a year whose last rental carries a rounding residue", () => {
    const rows = [row(1, 50_000, 0), row(2, 50_000, 0), row(3, 50_001, 0)]
    expect(leaseYearSummary(rows)[0].yearTotalCents).toBe(rows.reduce((s, r) => s + r.totalCents, 0))
  })

  it("is empty for no rows", () => {
    expect(leaseYearSummary([])).toEqual([])
  })
})
