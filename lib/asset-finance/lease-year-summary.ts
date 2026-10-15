// A lease schedule grouped by lease year (12 rentals), for the deal preview:
// the rental escalates once a year, so each year has one monthly amount.
// Pure and client-safe. The monthly figures are the year's first rental; the
// last rental of a lease absorbs a rounding residue, so the year's total is
// the sum of its rows, not months × the monthly figure.
import type { LeaseScheduleRow } from "./lease-view"

export interface LeaseYearSummary {
  year: number // 1-based
  rentals: number
  firstDueDate: string
  rentalExclVatCents: number // a month
  maintenanceExclVatCents: number // a month
  vatCents: number // a month
  totalCents: number // a month, incl. VAT
  yearTotalCents: number // the year's rentals incl. VAT
}

export function leaseYearSummary(rows: readonly LeaseScheduleRow[]): LeaseYearSummary[] {
  const years: LeaseYearSummary[] = []
  for (const row of rows) {
    const index = Math.floor((row.periodNo - 1) / 12)
    const current = years[index]
    if (current) {
      current.rentals += 1
      current.yearTotalCents += row.totalCents
      continue
    }
    years[index] = {
      year: index + 1, rentals: 1, firstDueDate: row.dueDate, rentalExclVatCents: row.rentalExclVatCents,
      maintenanceExclVatCents: row.maintenanceExclVatCents, vatCents: row.vatCents, totalCents: row.totalCents, yearTotalCents: row.totalCents,
    }
  }
  return years
}
