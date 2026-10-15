import type { RecoveryCost, RecoveryCostTreatment, RecoveryStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { PORTAL_AUTHORITY_ROLES } from "./portal-access"
import { isoOfDbDate } from "./dates"
import { costTotals } from "./recovery-outcome"
import { isNcaRoute } from "./recovery-input"
import { COST_TYPE_LABELS } from "./recovery-labels"

const NCA_FINAL: RecoveryStatus[] = ["FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED"]
const NON_NCA_FINAL: RecoveryStatus[] = ["PROCEEDS_APPLIED", "SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED"]
const VALUATION_NOTICED: RecoveryStatus[] = ["VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", ...NCA_FINAL]

// The valuation is for the consumer once it is a notice (NCA) or the asset is on sale (NON_NCA).
const NON_NCA_VALUATION_SHOWN: RecoveryStatus[] = ["LISTED", "SOLD", "PROCEEDS_APPLIED", "SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED"]

const iso = (d: Date | null): string | null => (d ? isoOfDbDate(d) : null)

const costView = (c: RecoveryCost) => ({
  id: c.id, type: c.type, label: COST_TYPE_LABELS[c.type], status: c.status, netCents: c.netCents, vatCents: c.vatCents, grossCents: c.grossCents, treatment: c.treatment,
  supplierId: c.supplierId, supplierInvoiceRef: c.supplierInvoiceRef, incurredOn: isoOfDbDate(c.incurredOn), legalStepId: c.legalStepId,
  note: c.note, recordedById: c.recordedById, approvedById: c.approvedById, approvedAt: c.approvedAt?.toISOString() ?? null,
})

/**
 * The staff recovery panel: everything on a recovery, its costs, sale
 * (screening kinds, never the buyer's identifier), figures and refund. With
 * `bankDetails` (people who manage or approve the refund) the refund carries
 * the account holder, bank, branch code, the last 4 digits of the account
 * number and the staff-served link to its verification document; the full
 * account number is never returned.
 */
export async function loadStaffRecoveryView(tenantId: string, id: string, opts: { bankDetails?: boolean } = {}) {
  const row = await prisma.recovery.findFirst({ where: { id, tenantId }, include: {
    valuation: true,
    costs: { orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }] },
    sales: { orderBy: { createdAt: "asc" } },
    refund: { select: { id: true, status: true, amountCents: true, createdById: true, approvedById: true, releasedAt: true, accountHolder: true, bankName: true, branchCode: true, accountNumber: true, bankVerifiedById: true } },
  } })
  if (!row) return null
  return {
    id: row.id, loanId: row.loanId, assetId: row.assetId, route: row.route, status: row.status,
    surrenderRequestId: row.surrenderRequestId, legalMatterId: row.legalMatterId, meterReadingId: row.meterReadingId,
    recoveredOn: isoOfDbDate(row.recoveredOn), location: row.location, condition: row.condition,
    valuation: row.valuation ? { id: row.valuation.id, valuedOn: isoOfDbDate(row.valuation.valuedOn), source: row.valuation.source, valuerName: row.valuation.valuerName, amountCents: row.valuation.amountCents } : null,
    notices: { valuationIssued: isNcaRoute(row.route) && VALUATION_NOTICED.includes(row.status), finalIssued: isNcaRoute(row.route) && NCA_FINAL.includes(row.status), finalNoticeIssuedOn: iso(row.finalNoticeIssuedOn) },
    costs: row.costs.filter((c) => c.status !== "PENDING").map(costView),
    pendingCosts: row.costs.filter((c) => c.status === "PENDING").map(costView),
    // Only APPROVED costs count: they are what the proceeds and the notices use.
    costTotals: costTotals(row.costs.filter((c) => c.status === "APPROVED")),
    sales: row.sales.map((s) => ({
      id: s.id, status: s.status, channel: s.channel, buyerType: s.buyerType, buyerName: s.buyerName, priceInclVatCents: s.priceInclVatCents,
      highestValuationCents: s.highestValuationCents, belowValuation: s.belowValuation, belowValuationReason: s.belowValuationReason,
      relatedPartyMatch: s.relatedPartyMatch, screeningResult: s.screeningResult, createdById: s.createdById, approvedById: s.approvedById,
      approvedAt: s.approvedAt?.toISOString() ?? null, completedAt: s.completedAt?.toISOString() ?? null,
    })),
    figures: row.settlementDueCents === null ? null : {
      settlementDueCents: row.settlementDueCents, grossProceedsCents: row.grossProceedsCents, deductedCostsCents: row.deductedCostsCents, chargedCostsCents: row.chargedCostsCents,
      netProceedsCents: row.netProceedsCents, shortfallCents: row.shortfallCents, surplusCents: row.surplusCents, proceedsPaymentId: row.proceedsPaymentId,
    },
    freeze: { from: iso(row.chargesFrozenFrom), until: iso(row.chargesFrozenUntil) },
    refund: row.refund ? {
      id: row.refund.id, status: row.refund.status, amountCents: row.refund.amountCents, createdById: row.refund.createdById,
      approvedById: row.refund.approvedById, releasedAt: row.refund.releasedAt?.toISOString() ?? null,
      bank: opts.bankDetails ? {
        accountHolder: row.refund.accountHolder, bankName: row.refund.bankName, branchCode: row.refund.branchCode,
        accountNumberLast4: row.refund.accountNumber.slice(-4), bankVerifiedById: row.refund.bankVerifiedById,
        verificationDocumentUrl: `/api/asset-finance/recoveries/${row.id}/refund/document`,
      } : null,
    } : null,
    withdrawnReason: row.withdrawnReason, closedAt: row.closedAt?.toISOString() ?? null,
  }
}

export interface PortalRecoveryView {
  status: RecoveryStatus
  recoveredOn: string
  asset: string
  valuationAmountCents: number | null
  notices: { valuation: boolean; final: boolean }
  /** Only once the final account exists; no buyer, sale or screening detail is ever included. */
  finalAccount: null | {
    grossProceedsCents: number
    deductedCostsCents: number
    netProceedsCents: number
    chargedCostsCents: number
    shortfallCents: number
    surplusCents: number
    costs: { label: string; grossCents: number; treatment: RecoveryCostTreatment }[]
    chargesFrozenUntil: string | null
  }
}

/** The consumer's view of the loan's latest recovery, or null when it has none. */
export async function loadPortalRecoveryView(tenantId: string, loanId: string): Promise<PortalRecoveryView | null> {
  const row = await prisma.recovery.findFirst({
    where: { tenantId, loanId }, orderBy: { createdAt: "desc" },
    include: { valuation: true, asset: true, costs: { where: { status: "APPROVED" }, orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }] } },
  })
  if (!row) return null
  const nca = isNcaRoute(row.route)
  const showAccount = (nca ? NCA_FINAL : NON_NCA_FINAL).includes(row.status) && row.netProceedsCents !== null
  return {
    status: row.status, recoveredOn: isoOfDbDate(row.recoveredOn), asset: `${row.asset.year} ${row.asset.make} ${row.asset.model}`,
    valuationAmountCents: (nca ? VALUATION_NOTICED : NON_NCA_VALUATION_SHOWN).includes(row.status) ? row.valuation?.amountCents ?? null : null,
    notices: { valuation: nca && VALUATION_NOTICED.includes(row.status), final: nca && NCA_FINAL.includes(row.status) },
    finalAccount: showAccount ? {
      grossProceedsCents: row.grossProceedsCents ?? 0, deductedCostsCents: row.deductedCostsCents ?? 0, netProceedsCents: row.netProceedsCents ?? 0,
      chargedCostsCents: row.chargedCostsCents ?? 0, shortfallCents: row.shortfallCents ?? 0, surplusCents: row.surplusCents ?? 0,
      costs: row.costs.map((c) => ({ label: COST_TYPE_LABELS[c.type], grossCents: c.grossCents, treatment: c.treatment })),
      chargesFrozenUntil: iso(row.chargesFrozenUntil),
    } : null,
  }
}

/** The loan is the client's own, or an entity's whose portal authority the client holds. */
export async function clientRecoveryAccess(tenantId: string, clientId: string, loanId: string): Promise<boolean> {
  return (await prisma.loan.count({ where: {
    id: loanId, tenantId, contractType: { not: "LOAN" },
    OR: [
      { clientId },
      { entity: { relationships: { some: { clientId, active: true, role: { in: [...PORTAL_AUTHORITY_ROLES] } } } } },
    ],
  } })) === 1
}
