import type { ContractType, LeaseEndOutcome, LeaseEndStatus, LeaseTerminationStatus, MaintenanceClaimStatus, MaintenanceMovementKind, ScheduleStatus, UsageUnit } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped, isoOfDbDate } from "@/lib/asset-finance/dates"
import { ELECTION_WINDOW_MONTHS } from "@/lib/asset-finance/lease-end-of-term"
import { leaseExpiryDate } from "@/lib/asset-finance/lease-daily"
import { fundBalance } from "@/lib/asset-finance/maintenance-fund"
import { projectedExcessUsage } from "@/lib/asset-finance/lease-usage"

// Everything the staff lease panel shows, read for one lease loan and the
// tenant (every top-level query passes tenantId, as the neighbours do). Plain
// values only: dates are ISO strings, Decimals strings, so the client
// components can take them as props.

export interface RentalRow {
  periodNo: number
  dueDate: string
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
  cancelled: boolean
  scheduleStatus: ScheduleStatus
  invoice: { id: string; number: string } | null
}
export interface MovementRow { id: string; kind: MaintenanceMovementKind; amountCents: number; occurredOn: string; periodNo: number | null }
export interface ClaimRow {
  id: string
  status: MaintenanceClaimStatus
  amountExclVatCents: number
  description: string
  supplier: string
  invoiceFile: string
  submittedOn: string
  submittedById: string
  firstApprovedById: string | null
  rejectionReason: string | null
  paymentReference: string | null
}
export interface FundView {
  riskModel: "LENDER_RISK" | "LESSEE_SETTLED"
  leaseEndDate: string
  settledAt: string | null
  balanceCents: number
  contributedCents: number
  claimedCents: number
  movements: MovementRow[]
  claims: ClaimRow[]
  dualApprovalCents: number
}
export interface ReadingRow { id: string; readingDate: string; value: number; source: string }
export interface UsageProjection { usedUnits: number; projectedFinalReading: number; excessCents: number; allowedUnits: number }
export interface EndOfTermView {
  outcome: LeaseEndOutcome
  status: LeaseEndStatus
  origin: string
  electedOn: string
  extensionNoticeOn: string | null
  extensionEndsOn: string | null
  inspectedOn: string | null
  condition: string | null
  finalReading: number | null
  damage: Array<{ id: string; description: string; amountExclVatCents: number }>
  purchasePriceExclVatCents: number | null
  excessUsageCents: number | null
  fundSettlementCents: number | null
  invoice: { id: string; number: string } | null
  natisRequired: boolean
  natisConfirmed: boolean
  completedOn: string | null
}
export interface QuoteRow {
  id: string
  status: LeaseTerminationStatus
  quotedOn: string
  terminationDate: string
  validUntil: string
  cpaCancellation: boolean
  remainingRentals: number
  pvCents: number
  penaltyCents: number
  arrearsCents: number
  invoiceVatCents: number
  totalCents: number
  basis: string
  invoice: { id: string; number: string } | null
}
export interface LeaseStaffData {
  loanId: string
  loanStatus: string
  contractType: Extract<ContractType, "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE">
  today: string
  maturityDate: string
  expiryDate: string
  electionOpensOn: string
  assetId: string | null
  deal: {
    id: string
    rentalTiming: string
    escalationRate: string
    earlyTerminationPenaltyRate: string
    usage: { unit: UsageUnit; allowancePerYear: number; excessRateCents: number } | null
  }
  cpaApplies: boolean | null
  rentals: RentalRow[]
  fund: FundView | null
  readings: ReadingRow[]
  usage: UsageProjection | null
  endOfTerm: EndOfTermView | null
  /** The CPA expiry notice, once the daily run has queued it (lib/asset-finance/lease-expiry.ts). */
  expiryNotice: { queuedOn: string } | null
  quotes: QuoteRow[]
  purchaseMaxAgeDays: number
}

const LEASES: ContractType[] = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"]
const invoiceOf = (invoice: { id: string; invoiceNumber: string } | null) => (invoice ? { id: invoice.id, number: invoice.invoiceNumber } : null)
const day = (date: Date | null) => (date ? isoOfDbDate(date) : null)

export async function loadLeaseStaffData(tenantId: string, loanId: string): Promise<LeaseStaffData | null> {
  const today = sastCalendarDate(new Date())
  const [loan, config] = await Promise.all([
    prisma.loan.findFirst({
      where: { id: loanId, tenantId, contractType: { in: LEASES } },
      select: {
        id: true, status: true, contractType: true, maturityDate: true, startDate: true, assetId: true, cpaApplies: true,
        asset: { select: { registrationNumber: true } },
        assetFinanceDeal: {
          select: { id: true, rentalTiming: true, escalationRate: true, earlyTerminationPenaltyRate: true, usageUnit: true, usageAllowancePerYear: true, excessRateCents: true },
        },
        leaseRentals: {
          orderBy: { periodNo: "asc" },
          select: {
            periodNo: true, dueDate: true, rentalExclVatCents: true, maintenanceExclVatCents: true, vatCents: true, totalCents: true, cancelledAt: true,
            taxInvoice: { select: { id: true, invoiceNumber: true } }, schedule: { select: { status: true } },
          },
        },
        meterReadings: { orderBy: [{ readingDate: "desc" }, { value: "desc" }], select: { id: true, readingDate: true, value: true, source: true } },
        maintenanceFund: {
          select: {
            riskModel: true, leaseEndDate: true, settledAt: true,
            movements: { orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }], select: { id: true, kind: true, amountCents: true, occurredOn: true, leaseRental: { select: { periodNo: true } } } },
            claims: {
              orderBy: { submittedAt: "desc" },
              select: {
                id: true, status: true, amountExclVatCents: true, description: true, submittedAt: true, submittedById: true, firstApprovedById: true,
                rejectionReason: true, paymentReference: true, supplier: { select: { name: true } }, providerInvoiceDocument: { select: { fileName: true } },
              },
            },
          },
        },
        leaseEndOfTerm: {
          include: { damageItems: { orderBy: { createdAt: "asc" } }, finalReading: { select: { value: true } }, taxInvoice: { select: { id: true, invoiceNumber: true } } },
        },
        leaseExpiryNotice: { select: { queuedOn: true } },
        leaseTerminationQuotes: { orderBy: [{ quotedOn: "desc" }, { createdAt: "desc" }], include: { taxInvoice: { select: { id: true, invoiceNumber: true } } } },
      },
    }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { maintenanceClaimDualApprovalCents: true, leasePurchaseValuationMaxAgeDays: true } }),
  ])
  const deal = loan?.assetFinanceDeal
  if (!loan || !deal || !deal.rentalTiming || !deal.escalationRate || !deal.earlyTerminationPenaltyRate) return null
  const contractType = loan.contractType === "FULL_MAINTENANCE_LEASE" ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE"

  const fundRow = loan.maintenanceFund
  const movements = fundRow?.movements ?? []
  const fund: FundView | null = fundRow && {
    riskModel: fundRow.riskModel,
    leaseEndDate: isoOfDbDate(fundRow.leaseEndDate),
    settledAt: fundRow.settledAt ? sastCalendarDate(fundRow.settledAt) : null,
    balanceCents: fundBalance(movements),
    contributedCents: movements.filter((m) => m.kind === "CONTRIBUTION").reduce((sum, m) => sum + m.amountCents, 0),
    claimedCents: movements.filter((m) => m.kind === "CLAIM").reduce((sum, m) => sum + m.amountCents, 0),
    movements: movements.map((m) => ({ id: m.id, kind: m.kind, amountCents: m.amountCents, occurredOn: isoOfDbDate(m.occurredOn), periodNo: m.leaseRental?.periodNo ?? null })),
    claims: fundRow.claims.map((c) => ({
      id: c.id, status: c.status, amountExclVatCents: c.amountExclVatCents, description: c.description, supplier: c.supplier.name,
      invoiceFile: c.providerInvoiceDocument.fileName, submittedOn: sastCalendarDate(c.submittedAt), submittedById: c.submittedById,
      firstApprovedById: c.firstApprovedById, rejectionReason: c.rejectionReason, paymentReference: c.paymentReference,
    })),
    dualApprovalCents: config?.maintenanceClaimDualApprovalCents ?? 5_000_000,
  }

  const usage = deal.usageUnit && deal.usageAllowancePerYear && deal.excessRateCents
    ? { unit: deal.usageUnit, allowancePerYear: deal.usageAllowancePerYear, excessRateCents: deal.excessRateCents }
    : null
  const readings: ReadingRow[] = loan.meterReadings.map((r) => ({ id: r.id, readingDate: isoOfDbDate(r.readingDate), value: r.value, source: r.source }))
  const maturityDate = sastCalendarDate(loan.maturityDate) // a timestamp at SAST midnight, not a calendar date
  const expiryDate = leaseExpiryDate(loan.maturityDate, deal.rentalTiming)
  const termMonths = loan.leaseRentals.filter((r) => !r.cancelledAt).length

  const eot = loan.leaseEndOfTerm
  return {
    loanId: loan.id, loanStatus: loan.status, contractType, today, maturityDate, expiryDate,
    electionOpensOn: addMonthsClamped(sastCalendarDate(loan.maturityDate), -ELECTION_WINDOW_MONTHS), assetId: loan.assetId,
    deal: { id: deal.id, rentalTiming: deal.rentalTiming, escalationRate: deal.escalationRate.toString(), earlyTerminationPenaltyRate: deal.earlyTerminationPenaltyRate.toString(), usage },
    cpaApplies: loan.cpaApplies,
    rentals: loan.leaseRentals.map((r) => ({
      periodNo: r.periodNo, dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents, maintenanceExclVatCents: r.maintenanceExclVatCents,
      vatCents: r.vatCents, totalCents: r.totalCents, cancelled: r.cancelledAt !== null, scheduleStatus: r.schedule.status, invoice: invoiceOf(r.taxInvoice),
    })),
    fund, readings,
    usage: usage ? projectUsage(usage, readings, { startDate: sastCalendarDate(loan.startDate), endDate: expiryDate, termMonths }) : null,
    endOfTerm: eot && {
      outcome: eot.outcome, status: eot.status, origin: eot.origin, electedOn: sastCalendarDate(eot.electedAt), extensionNoticeOn: day(eot.extensionNoticeOn),
      extensionEndsOn: day(eot.extensionEndsOn), inspectedOn: day(eot.inspectedOn), condition: eot.inspectionCondition, finalReading: eot.finalReading?.value ?? null,
      damage: eot.damageItems.map((d) => ({ id: d.id, description: d.description, amountExclVatCents: d.amountExclVatCents })),
      purchasePriceExclVatCents: eot.purchasePriceExclVatCents, excessUsageCents: eot.excessUsageCents, fundSettlementCents: eot.fundSettlementCents,
      invoice: invoiceOf(eot.taxInvoice), natisRequired: eot.outcome === "PURCHASE" && !!loan.asset?.registrationNumber?.trim(),
      natisConfirmed: eot.natisTransferConfirmedAt !== null, completedOn: eot.completedAt ? sastCalendarDate(eot.completedAt) : null,
    },
    expiryNotice: loan.leaseExpiryNotice && { queuedOn: isoOfDbDate(loan.leaseExpiryNotice.queuedOn) },
    quotes: loan.leaseTerminationQuotes.map((q) => ({
      id: q.id, status: q.status, quotedOn: isoOfDbDate(q.quotedOn), terminationDate: isoOfDbDate(q.terminationDate), validUntil: isoOfDbDate(q.validUntil),
      cpaCancellation: q.cpaCancellation, remainingRentals: q.remainingRentals, pvCents: q.pvCents, penaltyCents: q.penaltyCents, arrearsCents: q.arrearsCents,
      invoiceVatCents: q.invoiceVatCents, totalCents: q.totalCents, basis: q.basis, invoice: invoiceOf(q.taxInvoice),
    })),
    purchaseMaxAgeDays: config?.leasePurchaseValuationMaxAgeDays ?? 30,
  }
}

/** The usage so far and, extrapolated per day to the end of the term, the excess it would bill (lease-usage.ts). */
function projectUsage(
  usage: { unit: UsageUnit; allowancePerYear: number; excessRateCents: number },
  readings: ReadingRow[],
  term: { startDate: string; endDate: string; termMonths: number },
): UsageProjection | null {
  const latest = readings[0]
  const start = readings[readings.length - 1]
  if (!latest || !start || latest.id === start.id || term.termMonths < 1) return null
  const projected = projectedExcessUsage({
    startReading: start.value, allowancePerYear: usage.allowancePerYear, termMonths: term.termMonths, excessRateCents: usage.excessRateCents,
    startDate: term.startDate, latestReading: latest.value, latestDate: latest.readingDate, endDate: term.endDate,
  })
  return { usedUnits: latest.value - start.value, projectedFinalReading: projected.projectedFinalReading, excessCents: projected.excessCents, allowedUnits: Math.round(projected.allowedTwelfths / 12) }
}
