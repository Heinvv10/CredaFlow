/**
 * Repricing an operating or full-maintenance lease (slice 3, C3; DESIGN D4:
 * the term and the residual are unchanged). ./reprice-loan.ts runs the same
 * re-solve as for an instalment sale; this module is the lease's two
 * differences.
 *
 * READ. A lease's schedule rows hold whole VAT-inclusive rentals
 * (./lease-ledger.ts), not capital and interest. leaseCapitalRows rebuilds the
 * capital view the solver works on from each row's LeaseRental (the rental ex
 * VAT is the row's payment) and its capital opening balance
 * (assetFinanceOpeningBalanceCents): interest_i = opening_{i+1} − opening_i +
 * payment_i (+ the residual on the last row), as ./stored-schedule.ts derives
 * it. The residual is the deal's (Loan.balloonAmount is null on a lease).
 *
 * WRITE. writeLeaseRepricedRows writes each re-solved rental back: the
 * LeaseRental's rental, its VAT (per line, half-up, at the VAT rate the rental
 * was booked at; the maintenance line is unchanged) and total, and the
 * schedule row's principalDue = totalDue = that total. A rental already
 * invoiced is never repriced (the notice window keeps near rentals; an
 * invoiced row would be refused by guardLeaseRental). The LeaseRental guard
 * admits the amount change only inside this transaction's
 * credaflow.lease_reprice flag.
 */
import type { Prisma } from "@prisma/client"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { rateTenThousandthsOf } from "@/lib/vat/vat-rate"
import type { StoredScheduleRow } from "./stored-schedule"
import type { ScheduleRow } from "./types"
import type { RepriceTx } from "./reprice-loan"

type LeaseDb = Pick<RepriceTx, "$executeRawUnsafe" | "repaymentSchedule" | "leaseRental" | "assetFinanceDeal">

export interface LeaseCapitalView {
  rows: StoredScheduleRow[]
  residualCents: number
  advance: boolean
  rentals: Map<number, { id: string; rentalExclVatCents: number; maintenanceExclVatCents: number; vatRate: Prisma.Decimal; taxInvoiceId: string | null }>
}

export async function leaseCapitalRows(
  tx: LeaseDb,
  tenantId: string,
  loanId: string,
  stored: StoredScheduleRow[],
): Promise<LeaseCapitalView | { error: "unsupported_schedule" }> {
  const [deal, rentals] = await Promise.all([
    tx.assetFinanceDeal.findFirst({ where: { tenantId, loanId }, select: { balloonCents: true, rentalTiming: true } }),
    tx.leaseRental.findMany({
      where: { tenantId, loanId },
      orderBy: { periodNo: "asc" },
      select: { id: true, periodNo: true, scheduleId: true, rentalExclVatCents: true, maintenanceExclVatCents: true, vatRate: true, taxInvoiceId: true },
    }),
  ])
  if (!deal || rentals.length !== stored.length) return { error: "unsupported_schedule" }
  const last = stored.length - 1
  const rows: StoredScheduleRow[] = []
  for (let i = 0; i <= last; i++) {
    const row = stored[i]
    const rental = rentals[i]
    const opening = row.assetFinanceOpeningBalanceCents
    const nextOpening = i === last ? 0 : stored[i + 1].assetFinanceOpeningBalanceCents
    if (rental.scheduleId !== row.id || rental.periodNo !== row.installmentNo || opening == null || nextOpening == null) {
      return { error: "unsupported_schedule" }
    }
    const balloon = i === last ? deal.balloonCents : 0
    const payment = rental.rentalExclVatCents
    const interest = nextOpening - opening + payment + balloon
    const interestDue = Math.min(Math.max(interest, 0), payment)
    rows.push({
      ...row,
      principalDue: payment - interestDue + balloon,
      interestDue,
      feesDue: 0,
      creditLifePremiumDue: 0,
      totalDue: payment + balloon,
      // The funding cash basis excludes VAT and maintenance, including when
      // common-law replay supplied a gross collectible snapshot.
      collectibleTotalDue: payment + balloon,
    })
  }
  return {
    rows,
    residualCents: deal.balloonCents,
    advance: deal.rentalTiming === "ADVANCE",
    rentals: new Map(rentals.map((r) => [r.periodNo, r])),
  }
}

/** Writes the re-solved rentals; returns the change in the schedule's total due. */
export async function writeLeaseRepricedRows(
  tx: LeaseDb,
  tenantId: string,
  loanId: string,
  view: LeaseCapitalView,
  stored: StoredScheduleRow[],
  solvedRows: ScheduleRow[],
): Promise<number> {
  await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_reprice', 'on', true)")
  let change = 0
  for (const row of solvedRows) {
    const before = stored[row.index]
    const rental = view.rentals.get(before.installmentNo)
    if (!rental || rental.taxInvoiceId !== null) throw new Error(`lease reprice: rental ${before.installmentNo} of loan ${loanId} is invoiced or missing`)
    const rate = rateTenThousandthsOf(rental.vatRate)
    const rentalExclVatCents = row.totalCents - row.balloonCents
    const vatCents = vatOnExclusive(rentalExclVatCents, rate) + vatOnExclusive(rental.maintenanceExclVatCents, rate)
    const totalCents = rentalExclVatCents + rental.maintenanceExclVatCents + vatCents
    const updated = await tx.leaseRental.updateMany({
      where: { id: rental.id, tenantId, loanId, taxInvoiceId: null },
      data: { rentalExclVatCents, vatCents, totalCents },
    })
    const schedule = await tx.repaymentSchedule.updateMany({
      where: { id: before.id, tenantId, loanId, status: "PENDING", totalPaid: 0 },
      data: { principalDue: totalCents, interestDue: 0, totalDue: totalCents, assetFinanceOpeningBalanceCents: row.openingBalanceCents },
    })
    if (updated.count !== 1 || schedule.count !== 1) {
      throw new Error(`reprice: rental ${before.installmentNo} of loan ${loanId} changed underneath the repricing`)
    }
    change += totalCents - before.totalDue
  }
  await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_reprice', 'off', true)")
  return change
}
