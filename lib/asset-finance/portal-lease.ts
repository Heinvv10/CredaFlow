import type { AssetClass, ContractType, LeaseEndOutcome, LeaseEndStatus, LoanStatus, MaintenanceClaimStatus, MaintenanceRiskModel, MeterReadingSource, UsageUnit } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { portalLoanCharges } from "@/lib/portal/loan-charges"
import { resolveFeatureFlags } from "@/lib/tenant"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { MARKET_VALUATION_SOURCES } from "./lease-term-end"
import { findPortalLease } from "./lease-portal-route"
import { fundBalance } from "./maintenance-fund"
import { rentalOutstanding, rentalState, type PortalRentalState } from "./portal-lease-view"

// What a lessee sees of their lease in the portal (slice 3, C10): the rentals
// and their tax invoices, the other charges on the lease (end-of-term and
// early-termination invoices, and the NON_NCA default charges), the
// maintenance fund and its claims (full maintenance only), the meter, the
// latest early-termination quote and the end-of-term choice. The caller is a
// portal page; the lease is read only while the tenant's asset-finance module
// is on (as every lease route, ./require-enabled.ts) and after findPortalLease
// has said this client is the lessee (a sole proprietor) or holds authority
// over the lessee entity, the same gate the lease routes pass
// (./lease-portal-route.ts); it answers null otherwise. JSON-safe: ISO dates,
// money in cents.

export interface PortalLeaseRental {
  id: string
  periodNo: number
  dueDate: string
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
  paidCents: number
  outstandingCents: number
  state: PortalRentalState
  /** The rental's tax invoice once issued. */
  invoice: { id: string; invoiceNumber: string } | null
}

/** A charge on the lease that is not a rental: an end-of-term or early-termination invoice, collected as a schedule row (./lease-charges.ts). */
export interface PortalLeaseCharge {
  id: string
  kind: "END_OF_TERM" | "TERMINATION"
  dueDate: string
  totalCents: number
  paidCents: number
  outstandingCents: number
  state: PortalRentalState
  invoice: { id: string; invoiceNumber: string } | null
}

export interface PortalLeaseClaim {
  id: string
  submittedOn: string
  provider: string
  description: string
  amountExclVatCents: number
  status: MaintenanceClaimStatus
}

export interface PortalLeaseQuote {
  id: string
  quotedOn: string
  terminationDate: string
  validUntil: string
  status: "QUOTED" | "ACCEPTED"
  cpaCancellation: boolean
  remainingRentals: number
  pvCents: number
  penaltyCents: number
  arrearsCents: number
  invoiceVatCents: number
  totalCents: number
  basis: string
}

export interface PortalLeaseView {
  /** The SAST calendar day the view was read on. */
  today: string
  loan: { id: string; reference: string; status: LoanStatus; contractType: ContractType; startDate: string; maturityDate: string }
  entity: { id: string; legalName: string } | null
  asset: { assetClass: AssetClass; make: string; model: string; year: number; serialNumber: string; registrationNumber: string | null } | null
  rentals: PortalLeaseRental[]
  /** Overdue rentals only. */
  arrearsCents: number
  otherCharges: PortalLeaseCharge[]
  /** NON_NCA default charges (default interest and fees) owed today: the HP portal's source (lib/portal/loan-charges.ts). */
  defaultCharges: { outstandingCents: number; lines: Array<{ label: string; amount: number }> }
  /** Overdue rentals, overdue other charges and the default charges owed. */
  overdueInclChargesCents: number
  nextRental: { dueDate: string; amountCents: number } | null
  /** Full-maintenance leases only. */
  fund: { balanceCents: number; riskModel: MaintenanceRiskModel; claims: PortalLeaseClaim[] } | null
  /** Leases with contracted usage only. */
  /** The latest reading and who took it: the lessee sees a tracker's reading as the tracker's. */
  meter: { unit: UsageUnit; latest: { readingDate: string; value: number; source: MeterReadingSource } | null } | null
  termination: { cpaApplies?: boolean; penaltyConfigured: boolean; latestQuote: PortalLeaseQuote | null }
  endOfTerm: {
    chosen: { outcome: LeaseEndOutcome; status: LeaseEndStatus; early: boolean; inspected: boolean } | null
    valuation: { valuedOn: string; amountExclVatCents: number } | null
    /** A CPA expiry notice is queued for the lessee (its PDF is theirs to download). */
    expiryNotice: boolean
  }
}

export async function loadPortalLease(tenantId: string, clientId: string, loanId: string, asOf: Date = new Date()): Promise<PortalLeaseView | null> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId }, select: { featureCrm: true, featureIms: true, featureAssetFinance: true, leasePurchaseValuationMaxAgeDays: true },
  })
  if (!resolveFeatureFlags(config).featureAssetFinance) return null
  if (!(await findPortalLease(tenantId, clientId, loanId))) return null
  const today = sastCalendarDate(asOf)
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: {
      id: true, reference: true, status: true, contractType: true, startDate: true, maturityDate: true, assetId: true, cpaApplies: true,
      entity: { select: { id: true, legalName: true } },
      asset: { select: { assetClass: true, make: true, model: true, year: true, serialNumber: true, registrationNumber: true } },
      assetFinanceDeal: { select: { usageUnit: true, earlyTerminationPenaltyRate: true } },
      leaseEndOfTerm: { select: { outcome: true, status: true, origin: true, inspectedOn: true } },
      leaseExpiryNotice: { select: { id: true } },
      leaseRentals: {
        orderBy: { periodNo: "asc" },
        select: {
          id: true, periodNo: true, dueDate: true, rentalExclVatCents: true, maintenanceExclVatCents: true, vatCents: true, totalCents: true, cancelledAt: true,
          schedule: { select: { totalPaid: true } }, taxInvoice: { select: { id: true, invoiceNumber: true } },
        },
      },
      // The rows that are not rentals: the end-of-term and termination charges.
      repaymentSchedule: {
        where: { leaseRental: { is: null } },
        orderBy: { installmentNo: "asc" },
        select: {
          id: true, dueDate: true, totalDue: true, totalPaid: true,
          leaseEndOfTermCharge: { select: { taxInvoice: { select: { id: true, invoiceNumber: true } } } },
          leaseTerminationCharge: { select: { taxInvoice: { select: { id: true, invoiceNumber: true } } } },
        },
      },
      maintenanceFund: {
        select: {
          riskModel: true, movements: { select: { kind: true, amountCents: true } },
          claims: { orderBy: { submittedAt: "desc" }, select: { id: true, submittedAt: true, description: true, amountExclVatCents: true, status: true, supplier: { select: { name: true } } } },
        },
      },
    },
  })
  if (!loan) return null
  const unit = loan.assetFinanceDeal?.usageUnit ?? null
  const [latestReading, quote, charges] = await Promise.all([
    // This lease's readings only, as the staff panel reads them: an asset leased before has older readings of its own.
    unit
      ? prisma.assetMeterReading.findFirst({ where: { tenantId, loanId, unit }, orderBy: [{ readingDate: "desc" }, { value: "desc" }], select: { readingDate: true, value: true, source: true } })
      : null,
    prisma.leaseTerminationQuote.findFirst({ where: { tenantId, loanId }, orderBy: { createdAt: "desc" } }),
    portalLoanCharges(tenantId, loanId, asOf),
  ])
  // The valuation a purchase is priced on, as the end-of-term route picks it (./lease-term-end.ts bestMarketValuation).
  const since = fromDayNumber(toDayNumber(today) - (config?.leasePurchaseValuationMaxAgeDays ?? 30))
  const valuation = loan.assetId
    ? await prisma.assetValuation.findFirst({
      where: { tenantId, assetId: loan.assetId, source: { in: [...MARKET_VALUATION_SOURCES] }, valuedOn: { gte: dbDate(since) } },
      orderBy: [{ amountCents: "desc" }, { valuedOn: "desc" }], select: { valuedOn: true, amountCents: true },
    })
    : null

  const rentals: PortalLeaseRental[] = loan.leaseRentals.map((r) => {
    const row = { cancelled: r.cancelledAt !== null, totalCents: r.totalCents, paidCents: r.schedule.totalPaid, dueDate: isoOfDbDate(r.dueDate) }
    return {
      id: r.id, periodNo: r.periodNo, dueDate: row.dueDate,
      rentalExclVatCents: r.rentalExclVatCents, maintenanceExclVatCents: r.maintenanceExclVatCents, vatCents: r.vatCents, totalCents: r.totalCents,
      paidCents: row.paidCents, outstandingCents: rentalOutstanding(row), state: rentalState(row, today), invoice: r.taxInvoice,
    }
  })
  // A charge row is an end of term's or a termination's (the database links each; anything else is not shown as a charge).
  const otherCharges: PortalLeaseCharge[] = loan.repaymentSchedule.filter((s) => s.leaseTerminationCharge || s.leaseEndOfTermCharge).map((s) => {
    const row = { cancelled: false, totalCents: s.totalDue, paidCents: s.totalPaid, dueDate: sastCalendarDate(s.dueDate) }
    return {
      id: s.id, kind: s.leaseTerminationCharge ? "TERMINATION" : "END_OF_TERM", dueDate: row.dueDate, totalCents: s.totalDue, paidCents: s.totalPaid,
      outstandingCents: rentalOutstanding(row), state: rentalState(row, today),
      invoice: (s.leaseTerminationCharge ?? s.leaseEndOfTermCharge)?.taxInvoice ?? null,
    }
  })
  const overdue = (rows: Array<{ state: PortalRentalState; outstandingCents: number }>) =>
    rows.filter((r) => r.state === "OVERDUE").reduce((sum, r) => sum + r.outstandingCents, 0)
  const arrearsCents = overdue(rentals)
  const next = rentals.find((r) => r.outstandingCents > 0 && r.dueDate >= today)
  const fund = loan.maintenanceFund

  return {
    today,
    loan: { id: loan.id, reference: loan.reference, status: loan.status, contractType: loan.contractType, startDate: sastCalendarDate(loan.startDate), maturityDate: sastCalendarDate(loan.maturityDate) },
    entity: loan.entity,
    asset: loan.asset,
    rentals,
    arrearsCents,
    otherCharges,
    defaultCharges: { outstandingCents: charges.outstanding, lines: charges.lines },
    overdueInclChargesCents: arrearsCents + overdue(otherCharges) + charges.outstanding,
    nextRental: next ? { dueDate: next.dueDate, amountCents: next.outstandingCents } : null,
    fund: fund && {
      balanceCents: fundBalance(fund.movements), riskModel: fund.riskModel,
      claims: fund.claims.map((c) => ({
        id: c.id, submittedOn: c.submittedAt.toISOString(), provider: c.supplier.name, description: c.description, amountExclVatCents: c.amountExclVatCents, status: c.status,
      })),
    },
    meter: unit ? { unit, latest: latestReading ? { readingDate: isoOfDbDate(latestReading.readingDate), value: latestReading.value, source: latestReading.source } : null } : null,
    termination: {
      cpaApplies: loan.cpaApplies === true,
      penaltyConfigured: Boolean(loan.assetFinanceDeal?.earlyTerminationPenaltyRate),
      latestQuote: quote && {
        id: quote.id, quotedOn: isoOfDbDate(quote.quotedOn), terminationDate: isoOfDbDate(quote.terminationDate), validUntil: isoOfDbDate(quote.validUntil),
        status: quote.status, cpaCancellation: quote.cpaCancellation, remainingRentals: quote.remainingRentals, pvCents: quote.pvCents, penaltyCents: quote.penaltyCents,
        arrearsCents: quote.arrearsCents, invoiceVatCents: quote.invoiceVatCents, totalCents: quote.totalCents, basis: quote.basis,
      },
    },
    endOfTerm: {
      chosen: loan.leaseEndOfTerm && {
        outcome: loan.leaseEndOfTerm.outcome, status: loan.leaseEndOfTerm.status, early: loan.leaseEndOfTerm.origin === "EARLY_TERMINATION",
        inspected: loan.leaseEndOfTerm.inspectedOn !== null,
      },
      valuation: valuation && { valuedOn: isoOfDbDate(valuation.valuedOn), amountExclVatCents: valuation.amountCents },
      expiryNotice: loan.leaseExpiryNotice !== null,
    },
  }
}
