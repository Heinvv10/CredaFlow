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

const AF_TYPES = ["INSTALMENT_SALE", "FINANCE_LEASE", "OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const

/** A `@db.Date` column as SAST midnight of that calendar day. */
const dayOf = (d: Date) => sastDayStart(d.toISOString().slice(0, 10))

const INVOICE = {
  id: true, number: true, supplyDate: true, issueDate: true, totalExclVatCents: true, vatCents: true, totalInclVatCents: true,
} satisfies Prisma.TaxInvoiceSelect

type InvoiceRow = { id: string; supplyDate: Date; issueDate: Date; totalExclVatCents: number; vatCents: number; totalInclVatCents: number }

function toInvoice(row: InvoiceRow, assetSaleExclVatCents = 0): SourceInvoice {
  return {
    id: row.id, supplyDate: dayOf(row.supplyDate), issueDate: dayOf(row.issueDate),
    exclVatCents: row.totalExclVatCents, vatCents: row.vatCents, inclVatCents: row.totalInclVatCents, assetSaleExclVatCents,
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
      creditNotes: { orderBy: { number: "asc" }, select: { id: true, invoiceId: true, issueDate: true, exclVatCents: true, vatCents: true, inclVatCents: true } },
    },
  },
  leaseRentals: {
    where: { taxInvoiceId: { not: null } }, orderBy: { periodNo: "asc" },
    select: { id: true, rentalExclVatCents: true, maintenanceExclVatCents: true, vatCents: true, totalCents: true, taxInvoiceId: true },
  },
  leaseEndOfTerm: { select: { outcome: true, taxInvoiceId: true, purchasePriceExclVatCents: true } },
  maintenanceFund: { select: { riskModel: true, movements: { orderBy: { occurredOn: "asc" }, select: { id: true, kind: true, amountCents: true, occurredOn: true } } } },
  recoveries: {
    orderBy: { id: "asc" },
    select: {
      id: true, status: true, netProceedsCents: true, surplusCents: true, chargesFrozenFrom: true, proceedsPaymentId: true, closedAt: true,
      costs: { where: { status: "APPROVED" }, orderBy: { id: "asc" }, select: { id: true, netCents: true, vatCents: true, grossCents: true, treatment: true, incurredOn: true } },
      vatEvents: { where: { kind: "REPOSSESSION_DEEMED_SUPPLY" }, orderBy: { id: "asc" }, select: { id: true, eventDate: true, inputTaxClaimCents: true } },
      sales: { where: { status: "COMPLETED" }, select: { id: true, priceInclVatCents: true, taxInvoice: { select: { ...INVOICE, creditNotes: { select: { id: true } } } } } },
      refund: { where: { status: "RELEASED" }, select: { id: true, amountCents: true, releasedAt: true } },
    },
  },
} satisfies Prisma.LoanSelect

type LoanRow = Prisma.LoanGetPayload<{ select: typeof LOAN_SELECT }>

function recoveriesOf(loan: LoanRow, unsupported: Unsupported[]): SourceRecovery[] {
  return loan.recoveries.map((r) => {
    const sale = r.sales[0]
    if (sale && (!sale.taxInvoice || sale.taxInvoice.totalInclVatCents !== sale.priceInclVatCents)) {
      unsupported.push({ loanId: loan.id, message: `${loan.reference}: the remarketing sale has no tax invoice for its price` })
    }
    if (sale?.taxInvoice?.creditNotes.length) unsupported.push({ loanId: loan.id, message: `${loan.reference}: a credit note against the remarketing sale invoice is not exported yet` })
    const settled = r.netProceedsCents !== null && r.chargesFrozenFrom !== null
    return {
      id: r.id,
      proceedsDate: settled && r.chargesFrozenFrom ? dayOf(r.chargesFrozenFrom) : null,
      proceedsPaymentId: r.proceedsPaymentId,
      surplusCents: r.surplusCents ?? 0,
      withdrawnAt: r.status === "WITHDRAWN" ? r.closedAt : null,
      costs: r.costs.map((c) => ({ ...c, incurredOn: dayOf(c.incurredOn) })),
      vatEvents: r.vatEvents.filter((e) => e.inputTaxClaimCents > 0).map((e) => ({ id: e.id, eventDate: dayOf(e.eventDate), inputTaxClaimCents: e.inputTaxClaimCents })),
      sale: sale?.taxInvoice ? { id: sale.id, priceInclVatCents: sale.priceInclVatCents, invoice: toInvoice(sale.taxInvoice) } : null,
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
  if (lease) {
    if (!released) unsupported.push({ loanId: loan.id, message: `${loan.reference}: the supplier payout has not been released` })
    else if (released.amountCents !== asset.exclVatCents + asset.vatCents) unsupported.push({ loanId: loan.id, message: `${loan.reference}: a lease with a deposit or trade-in is not exported yet` })
  } else {
    if (!released) unsupported.push({ loanId: loan.id, message: `${loan.reference}: the supplier payout has not been released` })
    if (loan.taxInvoices.some((i) => i.creditNotes.length > 0)) unsupported.push({ loanId: loan.id, message: `${loan.reference}: a credit note against the inception invoice is not exported yet` })
    if (loan.taxInvoices.length === 0) unsupported.push({ loanId: loan.id, message: `${loan.reference}: no inception tax invoice` })
    if (loan.repaymentSchedule.some((r) => r.assetFinanceOpeningBalanceCents === null)) unsupported.push({ loanId: loan.id, message: `${loan.reference}: a schedule row has no opening balance` })
  }
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
      ? loan.taxInvoices.filter((i) => !rentalInvoiceIds.has(i.id)).map((i) => toInvoice(i, assetSale(i.id)))
      : [],
    creditNotes: lease ? loan.taxInvoices.flatMap((i) => i.creditNotes.map((n): SourceCreditNote => ({
      id: n.id, invoiceId: n.invoiceId, issueDate: dayOf(n.issueDate), exclVatCents: n.exclVatCents, vatCents: n.vatCents, inclVatCents: n.inclVatCents,
      invoiceIncome: i.leaseRental
        ? [{ role: "RENTAL_INCOME", exclVatCents: i.leaseRental.rentalExclVatCents }, { role: "MAINTENANCE_INCOME", exclVatCents: i.leaseRental.maintenanceExclVatCents }]
        : [{ role: "ASSET_DISPOSAL_PROCEEDS", exclVatCents: assetSale(i.id) }, { role: "RENTAL_INCOME", exclVatCents: i.totalExclVatCents - assetSale(i.id) }],
    }))) : [],
    fund: loan.maintenanceFund
      ? { riskModel: loan.maintenanceFund.riskModel, movements: loan.maintenanceFund.movements.map((m) => ({ ...m, occurredOn: dayOf(m.occurredOn) })) }
      : null,
    recoveries: recoveriesOf(loan, unsupported),
  }
}

export interface Unsupported { loanId: string; message: string }

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
