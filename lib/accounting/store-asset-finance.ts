/**
 * Reads the asset-finance contracts for the accounting export: instalment
 * sales, finance leases, operating and full-maintenance leases, with their
 * tax invoices, lease rentals, maintenance funds and recoveries.
 *
 * Like the consumer loader, tenant-scoped models need the caller inside the
 * tenant's context and every query names its tenant by hand. A contract the
 * sources cannot yet express is reported in `unsupported` instead of posted
 * wrongly: the plan refuses the close (AF_SOURCE_UNSUPPORTED).
 */
import type { Prisma } from "@prisma/client"
import { sastDayStart } from "@/lib/date/sast-period"
import { groupCharges, type AccountingDb } from "./store"
import type { SourceAssetFinance, SourceCreditNote, SourceInvoice, SourceLoan, SourceRecovery } from "./source-types"
import { creditShares } from "./sources-asset-finance"

const AF_TYPES = ["INSTALMENT_SALE", "FINANCE_LEASE", "OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const

/** A `@db.Date` column as SAST midnight of that calendar day. */
const dayOf = (d: Date) => sastDayStart(d.toISOString().slice(0, 10))

const INVOICE = {
  id: true, number: true, supplyDate: true, issueDate: true, totalExclVatCents: true, vatCents: true, totalInclVatCents: true,
} satisfies Prisma.TaxInvoiceSelect

const CREDIT_NOTE = { id: true, invoiceId: true, issueDate: true, exclVatCents: true, vatCents: true, inclVatCents: true } satisfies Prisma.CreditNoteSelect

type InvoiceRow = { id: string; supplyDate: Date; issueDate: Date; totalExclVatCents: number; vatCents: number; totalInclVatCents: number }

function toInvoice(row: InvoiceRow, assetSaleExclVatCents = 0, fundBilledExclVatCents = 0): SourceInvoice {
  return {
    id: row.id, supplyDate: dayOf(row.supplyDate), issueDate: dayOf(row.issueDate),
    exclVatCents: row.totalExclVatCents, vatCents: row.vatCents, inclVatCents: row.totalInclVatCents, assetSaleExclVatCents, fundBilledExclVatCents,
  }
}

const LOAN_SELECT = {
  id: true, reference: true, principal: true, initiationFee: true, startDate: true, status: true, writeOffAt: true, closedAt: true, contractType: true,
  repaymentSchedule: {
    orderBy: { installmentNo: "asc" },
    select: { id: true, installmentNo: true, dueDate: true, interestDue: true, feesDue: true, creditLifePremiumDue: true, totalDue: true, totalPaid: true, assetFinanceOpeningBalanceCents: true },
  },
  charges: { orderBy: [{ day: "asc" }, { type: "asc" }], select: { type: true, day: true, amount: true, sourceId: true } },
  payments: {
    orderBy: { id: "asc" },
    select: {
      id: true, amount: true, paymentMethod: true, receivedAt: true, allocationStatus: true, reconciledAt: true, reversed: true, reversedAt: true,
      parentPaymentId: true, defaultInterestAllocated: true, chargeFeesAllocated: true,
    },
  },
  asset: { select: { cashPriceExclVatCents: true, vatCents: true } },
  assetFinanceDeal: { select: { financedFeesCents: true, payout: { select: { amountCents: true, releasedAt: true, status: true } } } },
  taxInvoices: {
    orderBy: { number: "asc" },
    select: {
      ...INVOICE, leaseRental: { select: { id: true, rentalExclVatCents: true, maintenanceExclVatCents: true } },
      creditNotes: { orderBy: { number: "asc" }, select: CREDIT_NOTE },
    },
  },
  leaseRentals: {
    where: { taxInvoiceId: { not: null } }, orderBy: { periodNo: "asc" },
    select: { id: true, rentalExclVatCents: true, maintenanceExclVatCents: true, vatCents: true, totalCents: true, taxInvoiceId: true },
  },
  leaseEndOfTerm: { select: { outcome: true, taxInvoiceId: true, purchasePriceExclVatCents: true } },
  maintenanceFund: { select: { riskModel: true, movements: { orderBy: { occurredOn: "asc" }, select: { id: true, kind: true, amountCents: true, occurredOn: true, taxInvoiceId: true } } } },
  recoveries: {
    orderBy: { id: "asc" },
    select: {
      id: true, status: true, netProceedsCents: true, surplusCents: true, chargesFrozenFrom: true, proceedsPaymentId: true, closedAt: true,
      costs: { where: { status: "APPROVED" }, orderBy: { id: "asc" }, select: { id: true, netCents: true, vatCents: true, grossCents: true, treatment: true, incurredOn: true } },
      vatEvents: { where: { kind: "REPOSSESSION_DEEMED_SUPPLY" }, orderBy: { id: "asc" }, select: { id: true, eventDate: true, inputTaxClaimCents: true } },
      sales: { where: { status: "COMPLETED" }, select: { id: true, priceInclVatCents: true, completedAt: true, taxInvoice: { select: { ...INVOICE, creditNotes: { orderBy: { number: "asc" }, select: CREDIT_NOTE } } } } },
      refund: { where: { status: "RELEASED" }, select: { id: true, amountCents: true, releasedAt: true } },
    },
  },
} satisfies Prisma.LoanSelect

type LoanRow = Prisma.LoanGetPayload<{ select: typeof LOAN_SELECT }>

/** The earliest of the dates that are known; null when none is. */
function earliest(...dates: Array<Date | null | undefined>): Date | null {
  const known = dates.filter((d): d is Date => d instanceof Date)
  return known.length === 0 ? null : new Date(Math.min(...known.map((d) => d.getTime())))
}

function recoveriesOf(loan: LoanRow, unsupported: Unsupported[]): SourceRecovery[] {
  return loan.recoveries.map((r) => {
    const sale = r.sales[0]
    const soldOn = sale?.completedAt ?? null
    // From the earlier of the sale's completion and its invoice's date: the invoice's VAT posts on its own date.
    const saleFrom = earliest(soldOn, sale?.taxInvoice ? dayOf(sale.taxInvoice.issueDate) : null)
    if (sale && (!sale.taxInvoice || sale.taxInvoice.totalInclVatCents !== sale.priceInclVatCents)) {
      unsupported.push({ loanId: loan.id, from: saleFrom, message: `${loan.reference}: the remarketing sale has no tax invoice for its price` })
    }
    // A repossession's VAT event is made when a sale completes and a recovery with a completed sale cannot be withdrawn: such a record is not a state the rules produce.
    if (r.status === "WITHDRAWN" && (sale || r.vatEvents.length > 0)) {
      // From the earliest of the withdrawal, any VAT event and the sale: what was posted before the withdrawal is what cannot be.
      const from = earliest(r.closedAt, saleFrom, ...r.vatEvents.map((e) => dayOf(e.eventDate)))
      unsupported.push({ loanId: loan.id, from, message: `${loan.reference}: a withdrawn recovery has a sale or a repossession VAT event, which the rules do not allow` })
    }
    const settled = r.netProceedsCents !== null && r.chargesFrozenFrom !== null
    return {
      id: r.id,
      proceedsDate: settled && r.chargesFrozenFrom ? dayOf(r.chargesFrozenFrom) : null,
      proceedsPaymentId: r.proceedsPaymentId,
      surplusCents: r.surplusCents ?? 0,
      withdrawnAt: r.status === "WITHDRAWN" ? r.closedAt : null,
      costs: r.costs.map((c) => ({ ...c, incurredOn: dayOf(c.incurredOn) })),
      vatEvents: r.vatEvents.filter((e) => e.inputTaxClaimCents > 0).map((e) => ({ id: e.id, eventDate: dayOf(e.eventDate), inputTaxClaimCents: e.inputTaxClaimCents })),
      sale: sale?.taxInvoice ? {
        id: sale.id, priceInclVatCents: sale.priceInclVatCents, invoice: toInvoice(sale.taxInvoice),
        creditNotes: sale.taxInvoice.creditNotes.map((n) => ({ id: n.id, issueDate: dayOf(n.issueDate), exclVatCents: n.exclVatCents, vatCents: n.vatCents, inclVatCents: n.inclVatCents })),
      } : null,
      refund: r.refund?.releasedAt ? { id: r.refund.id, amountCents: r.refund.amountCents, releasedAt: r.refund.releasedAt } : null,
    }
  })
}

function assetFinanceOf(loan: LoanRow, unsupported: Unsupported[]): SourceAssetFinance {
  const contractType = loan.contractType as SourceAssetFinance["contractType"]
  const lease = contractType === "OPERATING_LEASE" || contractType === "FULL_MAINTENANCE_LEASE"
  const deal = loan.assetFinanceDeal
  const released = deal?.payout?.status === "RELEASED" && deal.payout.releasedAt ? { amountCents: deal.payout.amountCents, releasedAt: deal.payout.releasedAt } : null
  const asset = { exclVatCents: loan.asset?.cashPriceExclVatCents ?? 0, vatCents: loan.asset?.vatCents ?? 0 }
  const byId = new Map(loan.taxInvoices.map((i) => [i.id, i]))
  const eot = loan.leaseEndOfTerm
  const assetSale = (invoiceId: string) => (eot?.outcome === "PURCHASE" && eot.taxInvoiceId === invoiceId ? eot.purchasePriceExclVatCents ?? 0 : 0)
  const rentalInvoiceIds = new Set(loan.taxInvoices.filter((i) => i.leaseRental).map((i) => i.id))
  // Booking creates the loan and releases the payout in one transaction (lib/asset-finance/booking.ts, lease-booking.ts), so a booked
  // contract with an unreleased payout is not a state the app produces. If one exists it cannot be posted, from the day it was booked
  // (never for the months before). What cannot be expressed blocks the months from the payout's release on.
  const bookedOn = !lease && loan.taxInvoices[0] ? dayOf(loan.taxInvoices[0].supplyDate) : loan.startDate
  const from = released?.releasedAt ?? bookedOn
  const flag = (message: string) => unsupported.push({ loanId: loan.id, from, message: `${loan.reference}: ${message}` })
  if (!released) flag("the supplier payout has not been released")
  else if (lease) {
    if (released.amountCents !== asset.exclVatCents + asset.vatCents) flag("a lease with a deposit or trade-in is not exported yet")
  } else {
    if (loan.taxInvoices.slice(1).some((i) => i.creditNotes.length > 0)) flag("a credit note against a tax invoice other than the inception invoice is not exported yet")
    if (loan.taxInvoices.length === 0) flag("no inception tax invoice")
    if (loan.repaymentSchedule.some((r) => r.assetFinanceOpeningBalanceCents === null)) flag("a schedule row has no opening balance")
  }
  const billed = (invoiceId: string) => (loan.maintenanceFund?.movements ?? []).filter((m) => m.kind === "SETTLEMENT_BILLED" && m.taxInvoiceId === invoiceId).reduce((sum, m) => sum + m.amountCents, 0)
  return {
    contractType,
    financedFeesCents: deal?.financedFeesCents ?? 0,
    payout: released,
    inceptionInvoice: !lease && loan.taxInvoices[0] ? toInvoice(loan.taxInvoices[0]) : null,
    asset,
    rentals: loan.leaseRentals.flatMap((r) => {
      const invoice = r.taxInvoiceId ? byId.get(r.taxInvoiceId) : undefined
      return invoice ? [{ id: r.id, invoice: toInvoice(invoice), rentalExclVatCents: r.rentalExclVatCents, maintenanceExclVatCents: r.maintenanceExclVatCents, vatCents: r.vatCents, totalCents: r.totalCents }] : []
    }),
    sundryInvoices: lease
      ? loan.taxInvoices.filter((i) => !rentalInvoiceIds.has(i.id)).map((i) => toInvoice(i, assetSale(i.id), billed(i.id)))
      : [],
    creditNotes: !lease ? (loan.taxInvoices[0]?.creditNotes ?? []).map((n): SourceCreditNote => ({
      id: n.id, invoiceId: n.invoiceId, issueDate: dayOf(n.issueDate), exclVatCents: n.exclVatCents, vatCents: n.vatCents, inclVatCents: n.inclVatCents,
      // The inception invoice is one line, the asset at its cash price (lib/vat/tax-invoice.ts): its whole value is the price.
      invoiceIncome: [{ role: "AF_PRICE_CREDITS", exclVatCents: loan.taxInvoices[0].totalExclVatCents }],
    })) : loan.taxInvoices.flatMap((i) => i.creditNotes.map((n): SourceCreditNote => {
      const note: SourceCreditNote = {
        id: n.id, invoiceId: n.invoiceId, issueDate: dayOf(n.issueDate), exclVatCents: n.exclVatCents, vatCents: n.vatCents, inclVatCents: n.inclVatCents,
        invoiceIncome: i.leaseRental
          ? [{ role: "RENTAL_INCOME", exclVatCents: i.leaseRental.rentalExclVatCents }, { role: "MAINTENANCE_INCOME", exclVatCents: i.leaseRental.maintenanceExclVatCents }]
          : [
            { role: "ASSET_DISPOSAL_PROCEEDS", exclVatCents: assetSale(i.id) }, { role: "MAINTENANCE_FUND_LIABILITY", exclVatCents: billed(i.id) },
            { role: "RENTAL_INCOME", exclVatCents: i.totalExclVatCents - assetSale(i.id) - billed(i.id) },
          ],
      }
      // A credit with no income to spread over cannot be posted in balance: refuse the close rather than crash the preview.
      if (creditShares(note).length === 0) unsupported.push({ loanId: loan.id, from: note.issueDate, message: `${loan.reference}: a credit note on an invoice with no income to credit` })
      return note
    })),
    fund: loan.maintenanceFund
      ? { riskModel: loan.maintenanceFund.riskModel, movements: loan.maintenanceFund.movements.map((m) => ({ ...m, occurredOn: dayOf(m.occurredOn) })) }
      : null,
    recoveries: recoveriesOf(loan, unsupported),
  }
}

/** `from`: the contract blocks the months that end after this instant; null blocks every month. */
export interface Unsupported { loanId: string; from: Date | null; message: string }

export interface AssetFinanceLoans {
  loans: SourceLoan[]
  /** Contracts the sources cannot yet express, one sentence each. */
  unsupported: Unsupported[]
}

/** Every asset-finance contract of the tenant, with the money sources the journals need. */
export async function loadAssetFinanceLoans(db: AccountingDb, tenantId: string): Promise<AssetFinanceLoans> {
  const rows: LoanRow[] = await db.loan.findMany({ where: { tenantId, contractType: { in: [...AF_TYPES] } }, orderBy: { id: "asc" }, select: LOAN_SELECT })
  const unsupported: Unsupported[] = []
  const loans = rows.map((loan): SourceLoan => {
    const assetFinance = assetFinanceOf(loan, unsupported)
    const proceeds = new Set(assetFinance.recoveries.map((r) => r.proceedsPaymentId))
    return {
      id: loan.id, reference: loan.reference, principal: loan.principal, initiationFee: loan.initiationFee, upfrontFee: false,
      startDate: loan.startDate, status: loan.status, writeOffAt: loan.writeOffAt, closedAt: loan.closedAt, reversedAt: null,
      schedule: loan.repaymentSchedule.map(({ assetFinanceOpeningBalanceCents, ...r }) => ({ ...r, openingBalanceCents: assetFinanceOpeningBalanceCents })),
      charges: groupCharges(loan.charges),
      payments: loan.payments.map((p) => ({ ...p, recoveryProceeds: proceeds.has(p.id) })),
      payouts: [], recoveries: [],
      receivableRole: assetFinance.contractType === "OPERATING_LEASE" || assetFinance.contractType === "FULL_MAINTENANCE_LEASE" ? "LEASE_DEBTORS" : "AF_INSTALMENT_DEBTORS",
      assetFinance,
    }
  })
  return { loans, unsupported }
}
