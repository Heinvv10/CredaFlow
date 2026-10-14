import type { AssetClass, ContractType, DealDocumentKind, LoanStatus, Prisma, ReferenceRateBasis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate, sastStartOfDay } from "@/lib/date/sast"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { portalLoanCharges, portalOutstanding } from "@/lib/portal/loan-charges"
import { dbDate } from "./dates"
import { signerState, type SignerState } from "./signing"

// What an authorised director, trustee or signatory sees of one of their
// entity's booked contracts in the portal (goal §4.12). The caller has already
// checked the client's authority over `entityId` (requirePortalEntityAccess);
// this loader only reads, and answers null for a loan that is not this
// entity's, so a URL pairing an entity the client may see with another
// entity's loan is a 404, never a leak. Everything is JSON-safe (ISO dates,
// rates as decimal strings, money in cents) for the page and the API alike.

export type PortalScheduleState = "PAID" | "PARTIAL" | "OVERDUE" | "PENDING" | "SKIP"

export interface PortalScheduleRow {
  installmentNo: number
  dueDate: string
  totalDueCents: number
  paidCents: number
  /** The balloon inside totalDueCents (the final row only). */
  balloonCents: number
  state: PortalScheduleState
}

export interface PortalContractDocument {
  signerId: string
  document: DealDocumentKind
  signerName: string
  state: SignerState
  /** The wet-ink scan (an EntityDocument of the entity), when one was uploaded. */
  scanDocumentId: string | null
}

export interface PortalContractView {
  loan: { id: string; reference: string; status: LoanStatus; contractType: ContractType }
  entity: { id: string; legalName: string }
  asset: { assetClass: AssetClass; make: string; model: string; year: number; serialNumber: string; registrationNumber: string | null } | null
  rate: { basis: ReferenceRateBasis; margin: string | null; currentRate: string; effectiveDate: string } | null
  startDate: string
  maturityDate: string
  balloonCents: number
  outstandingCents: number
  /**
   * Default charges are live for this loan (lib/loan/charges-summary.ts
   * loanSettlementFigures, the source the charges replay uses): then
   * outstandingCents is the amount to settle today, otherwise the outstanding
   * principal. Live charges may have no lines yet (nothing owed).
   */
  chargesLive: boolean
  chargeLines: Array<{ label: string; amount: number }>
  arrears: { amountCents: number; days: number }
  nextPayment: { dueDate: string; amountCents: number } | null
  schedule: PortalScheduleRow[]
  taxInvoice: { id: string; invoiceNumber: string; issueDate: string; totalInclVatCents: number } | null
  documents: PortalContractDocument[]
}

/**
 * The signer rows of a deal a portal client may read: the entity's own
 * documents (agreement, resolution), which the client acts for, and the
 * client's OWN suretyship. Another surety's suretyship is a personal contract
 * between that person and the lender, so it is never listed or served.
 */
export function portalVisibleSignerWhere(clientId: string): Prisma.DealSignerWhereInput {
  return { OR: [{ document: { in: ["AGREEMENT", "RESOLUTION"] } }, { clientId }] }
}

/** The entity a portal-visible (entity-borrower) loan belongs to, or null. */
export async function findPortalLoanEntity(tenantId: string, loanId: string): Promise<string | null> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId, entityId: { not: null } }, select: { entityId: true } })
  return loan?.entityId ?? null
}

/** The loan's inception tax invoice (the first issued against it), if any. */
export async function findLoanTaxInvoiceId(tenantId: string, loanId: string): Promise<string | null> {
  const invoice = await prisma.taxInvoice.findFirst({ where: { tenantId, loanId }, orderBy: { number: "asc" }, select: { id: true } })
  return invoice?.id ?? null
}

function rowState(row: { dueDate: Date; totalDue: number; totalPaid: number }, today: number): PortalScheduleState {
  if (row.totalDue === 0) return "SKIP"
  if (row.totalPaid >= row.totalDue) return "PAID"
  if (row.totalPaid > 0) return "PARTIAL"
  return sastStartOfDay(row.dueDate).getTime() < today ? "OVERDUE" : "PENDING"
}

export async function loadPortalContract(
  tenantId: string,
  entityId: string,
  loanId: string,
  clientId: string,
  asOf: Date = new Date(),
): Promise<PortalContractView | null> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId, entityId },
    select: {
      id: true, reference: true, status: true, contractType: true, principal: true, balloonAmount: true,
      startDate: true, maturityDate: true,
      asset: { select: { assetClass: true, make: true, model: true, year: true, serialNumber: true, registrationNumber: true } },
      repaymentSchedule: {
        orderBy: { installmentNo: "asc" },
        select: { installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
      },
      assetFinanceDeal: { select: { id: true, entity: { select: { id: true, legalName: true } } } },
    },
  })
  if (!loan?.assetFinanceDeal?.entity) return null
  const deal = loan.assetFinanceDeal
  const entity = deal.entity
  if (!entity) return null

  const [rate, taxInvoice, signers, charges] = await Promise.all([
    prisma.contractRate.findFirst({
      where: { tenantId, loanId, effectiveDate: { lte: dbDate(sastCalendarDate(asOf)) } },
      orderBy: { effectiveDate: "desc" },
      select: { basis: true, margin: true, resultingRate: true, effectiveDate: true },
    }).then((current) => current ?? prisma.contractRate.findFirst({
      where: { tenantId, loanId },
      orderBy: { effectiveDate: "asc" },
      select: { basis: true, margin: true, resultingRate: true, effectiveDate: true },
    })),
    prisma.taxInvoice.findFirst({
      where: { tenantId, loanId },
      orderBy: { number: "asc" },
      select: { id: true, invoiceNumber: true, issueDate: true, totalInclVatCents: true },
    }),
    prisma.dealSigner.findMany({
      where: { tenantId, dealId: deal.id, documentStoragePath: { not: null }, ...portalVisibleSignerWhere(clientId) },
      orderBy: [{ document: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, document: true, method: true, signedAt: true, signatureSha256: true, scanDocumentId: true, confirmedById: true, confirmedAt: true,
        client: { select: { firstName: true, lastName: true } },
      },
    }),
    portalLoanCharges(tenantId, loanId, asOf),
  ])

  const rows = loan.repaymentSchedule
  const balances = recomputeLoanBalances(loan.principal, rows, asOf)
  const today = sastStartOfDay(asOf).getTime()
  const balloon = loan.balloonAmount ?? 0
  const upcoming = rows.find((r) => r.totalPaid < r.totalDue && sastStartOfDay(r.dueDate).getTime() >= today)

  return {
    loan: { id: loan.id, reference: loan.reference, status: loan.status, contractType: loan.contractType },
    entity,
    asset: loan.asset,
    rate: rate && {
      basis: rate.basis,
      margin: rate.margin?.toString() ?? null,
      currentRate: rate.resultingRate.toString(),
      effectiveDate: rate.effectiveDate.toISOString(),
    },
    startDate: loan.startDate.toISOString(),
    maturityDate: loan.maturityDate.toISOString(),
    balloonCents: balloon,
    outstandingCents: portalOutstanding(balances.outstandingPrincipal, charges),
    chargesLive: charges.settlementAmount !== null,
    chargeLines: charges.lines,
    arrears: { amountCents: balances.arrearsAmount, days: balances.daysInArrears },
    nextPayment: upcoming ? { dueDate: upcoming.dueDate.toISOString(), amountCents: upcoming.totalDue - upcoming.totalPaid } : null,
    schedule: rows.map((r, i) => ({
      installmentNo: r.installmentNo,
      dueDate: r.dueDate.toISOString(),
      totalDueCents: r.totalDue,
      paidCents: r.totalPaid,
      balloonCents: i === rows.length - 1 ? balloon : 0,
      state: rowState(r, today),
    })),
    taxInvoice: taxInvoice && {
      id: taxInvoice.id,
      invoiceNumber: taxInvoice.invoiceNumber,
      issueDate: taxInvoice.issueDate.toISOString(),
      totalInclVatCents: taxInvoice.totalInclVatCents,
    },
    documents: signers.map((s) => ({
      signerId: s.id,
      document: s.document,
      signerName: `${s.client.firstName} ${s.client.lastName}`,
      state: signerState(s),
      scanDocumentId: s.scanDocumentId,
    })),
  }
}
