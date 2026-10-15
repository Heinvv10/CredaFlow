// The rental schedule of a priced lease as staff and the portal show it:
// per period the rental, maintenance, VAT and total. Pure and client-safe.
import type { LeasePricingResult } from "./lease-pricing"

export interface LeaseScheduleRow {
  periodNo: number
  dueDate: string
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
}

export interface LeaseScheduleView {
  vatRate: string
  baseRentalCents: number
  rows: LeaseScheduleRow[]
  totalRentalExclVatCents: number
  totalMaintenanceExclVatCents: number
  totalVatCents: number
  totalCents: number
}

export function leaseScheduleView(lease: LeasePricingResult, vatRate: string): LeaseScheduleView {
  return {
    vatRate,
    baseRentalCents: lease.baseRentalCents,
    rows: lease.periods.map((p) => ({
      periodNo: p.periodNo,
      dueDate: p.dueDate,
      rentalExclVatCents: p.rentalExclVatCents,
      maintenanceExclVatCents: p.maintenanceExclVatCents,
      vatCents: p.vatCents,
      totalCents: p.totalCents,
    })),
    totalRentalExclVatCents: lease.totalRentalExclVatCents,
    totalMaintenanceExclVatCents: lease.totalMaintenanceExclVatCents,
    totalVatCents: lease.totalVatCents,
    totalCents: lease.totalCents,
  }
}
