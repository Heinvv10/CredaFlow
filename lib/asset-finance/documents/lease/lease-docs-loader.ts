// Reads the rows behind the three lease servicing documents (slice 3, C9),
// scoped to the tenant and to its leases. Each loader returns null when the
// row does not exist for that lease (the route answers 404). No rendering here.
import type { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "../../dates"
import { EXTENSION_NOTICE_MONTHS } from "../../lease-end-of-term"
import type { ExpiryNoticeData, InspectionReadingRow, InspectionReportData, LeaseDocBase, TerminationQuoteData } from "./lease-docs-types"

export type LeaseDocsDb = Pick<typeof prisma, "leaseExpiryNotice" | "leaseTerminationQuote" | "leaseEndOfTerm" | "assetMeterReading" | "tenantConfig">

const LEASES = { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } as const satisfies { in: ("OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE")[] }

const LOAN_SELECT = {
  id: true,
  reference: true,
  entity: { select: { legalName: true, registrationNumber: true } },
  client: { select: { firstName: true, lastName: true } },
  asset: { select: { make: true, model: true, year: true, serialNumber: true } },
} as const

interface LoanRow {
  id: string
  reference: string
  entity: { legalName: string; registrationNumber: string } | null
  client: { firstName: string; lastName: string } | null
  asset: { make: string; model: string; year: number; serialNumber: string } | null
}

async function baseOf(db: LeaseDocsDb, tenantId: string, loan: LoanRow): Promise<LeaseDocBase> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { assetFinanceLegalWordingApproved: true } })
  return {
    loanId: loan.id,
    reference: loan.reference,
    lessee: loan.entity ? `${loan.entity.legalName} (${loan.entity.registrationNumber})` : `${loan.client?.firstName ?? ""} ${loan.client?.lastName ?? ""}`.trim(),
    asset: loan.asset ? `${loan.asset.year} ${loan.asset.make} ${loan.asset.model}, serial ${loan.asset.serialNumber}` : "—",
    draft: config?.assetFinanceLegalWordingApproved !== true,
  }
}

export async function loadExpiryNotice(db: LeaseDocsDb, tenantId: string, loanId: string): Promise<ExpiryNoticeData | null> {
  const notice = await db.leaseExpiryNotice.findFirst({
    where: { tenantId, loanId, loan: { contractType: LEASES } },
    select: { id: true, expiryDate: true, queuedOn: true, loan: { select: LOAN_SELECT } },
  })
  if (!notice) return null
  return {
    ...(await baseOf(db, tenantId, notice.loan)),
    noticeId: notice.id,
    expiryDate: isoOfDbDate(notice.expiryDate),
    queuedOn: isoOfDbDate(notice.queuedOn),
    extensionNoticeMonths: EXTENSION_NOTICE_MONTHS,
  }
}

export async function loadTerminationQuote(db: LeaseDocsDb, tenantId: string, loanId: string, quoteId: string): Promise<TerminationQuoteData | null> {
  const quote = await db.leaseTerminationQuote.findFirst({
    where: { id: quoteId, tenantId, loanId, loan: { contractType: LEASES } },
    select: {
      id: true, status: true, quotedOn: true, terminationDate: true, validUntil: true, cpaCancellation: true, remainingRentals: true,
      pvCents: true, penaltyCents: true, arrearsCents: true, invoiceExclVatCents: true, invoiceVatCents: true, totalCents: true, basis: true,
      loan: { select: LOAN_SELECT },
    },
  })
  if (!quote) return null
  const { loan, id, quotedOn, terminationDate, validUntil, ...figures } = quote
  return {
    ...(await baseOf(db, tenantId, loan)),
    ...figures,
    quoteId: id,
    quotedOn: isoOfDbDate(quotedOn),
    terminationDate: isoOfDbDate(terminationDate),
    validUntil: isoOfDbDate(validUntil),
  }
}

const readingOf = (row: InspectionReadingRow | null) => (row ? { value: row.value, date: isoOfDbDate(row.readingDate), unit: row.unit } : null)

/** Null until an inspection has been recorded. The start reading is the lease's earliest in the final reading's unit, as the end-of-term invoice takes it. */
export async function loadInspectionReport(db: LeaseDocsDb, tenantId: string, loanId: string): Promise<InspectionReportData | null> {
  const row = await db.leaseEndOfTerm.findFirst({
    where: { tenantId, loanId, inspectedOn: { not: null }, loan: { contractType: LEASES } },
    select: {
      id: true, origin: true, outcome: true, inspectedOn: true, inspectionCondition: true, excessUsageCents: true,
      finalReading: { select: { value: true, readingDate: true, unit: true } },
      damageItems: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { description: true, amountExclVatCents: true } },
      loan: { select: LOAN_SELECT },
    },
  })
  if (!row?.inspectedOn) return null
  const start = row.finalReading
    ? await db.assetMeterReading.findFirst({
      where: { tenantId, loanId, unit: row.finalReading.unit },
      orderBy: [{ readingDate: "asc" }, { value: "asc" }],
      select: { value: true, readingDate: true, unit: true },
    })
    : null
  return {
    ...(await baseOf(db, tenantId, row.loan)),
    endOfTermId: row.id,
    origin: row.origin,
    outcome: row.outcome,
    inspectedOn: isoOfDbDate(row.inspectedOn),
    condition: row.inspectionCondition ?? "Not recorded",
    startReading: readingOf(start),
    finalReading: readingOf(row.finalReading),
    damage: row.damageItems,
    excessUsageCents: row.excessUsageCents,
  }
}
