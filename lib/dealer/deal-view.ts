/**
 * What a dealer sees of its own deals: a whitelist `select`, never the deal
 * row. Never: the credit decision or its reasons, approval exceptions,
 * financials, affordability, bureau or screening results, the NCA regime,
 * rule or override, the payout, or another dealer's rows. A declined deal
 * shows "Declined" and nothing of why. Every query filters
 * { tenantId, dealerId }; a miss is 404 (lib/dealer/deals.ts).
 *
 * People on the deal are named only when this dealer captured them; one the
 * lender added is "a person added by the lender" (spec deviation 9).
 */
import type { AssetDealStatus, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { DealerActor } from "./actor"
import { dealerDealWhere } from "./deals"

export type DealerDealStatus = "Draft" | "In review" | "Approved" | "Signed" | "Booked" | "Declined" | "Cancelled"

export function dealerStatus(status: AssetDealStatus, dealerSubmittedAt: Date | null): DealerDealStatus {
  switch (status) {
    case "DRAFT": return dealerSubmittedAt ? "In review" : "Draft"
    case "SUBMITTED":
    case "REFERRED": return "In review"
    case "APPROVED": return "Approved"
    case "CONTRACTED": return "Signed"
    case "BOOKED": return "Booked"
    case "DECLINED":
    case "REFUSED_NCA": return "Declined"
    case "CANCELLED": return "Cancelled"
  }
}

const PERSON = { select: { id: true, firstName: true, lastName: true, createdByDealerId: true } } as const

export const DEALER_DEAL_LIST_SELECT = {
  id: true, createdAt: true, status: true, dealerSubmittedAt: true, contractType: true,
  application: { select: { reference: true } },
  entity: { select: { legalName: true } },
  client: { select: { firstName: true, lastName: true } },
  asset: { select: { make: true, model: true, year: true, serialNumber: true } },
} as const satisfies Prisma.AssetFinanceDealSelect

export const DEALER_DEAL_SELECT = {
  ...DEALER_DEAL_LIST_SELECT,
  baseInstalmentCents: true,
  clientId: true,
  application: { select: { reference: true, appliedAmount: true } },
  entity: { select: { legalName: true, relationships: { where: { active: true }, select: { client: PERSON } } } },
  client: PERSON,
  loan: { select: { reference: true, startDate: true } },
  signers: { select: { document: true, role: true, signedAt: true, confirmedAt: true }, orderBy: { id: "asc" } },
  checklist: { select: { item: true, required: true, confirmedAt: true } },
  dealerConsentAttestations: { select: { clientId: true, verifiedAt: true } },
  dealerDocumentRequests: { select: { id: true, docType: true, note: true, requestedAt: true, fulfilledAt: true }, orderBy: { requestedAt: "asc" } },
  documents: { where: { uploadedByType: "dealer", deletedAt: null }, select: { id: true, docType: true, fileName: true, createdAt: true }, orderBy: { createdAt: "asc" } },
  dealerCommissionLines: {
    select: { kind: true, effectiveOn: true, netCents: true, vatCents: true, grossCents: true, reason: true },
    orderBy: { createdAt: "asc" },
  },
} as const satisfies Prisma.AssetFinanceDealSelect

type ListRow = Prisma.AssetFinanceDealGetPayload<{ select: typeof DEALER_DEAL_LIST_SELECT }>
type Row = Prisma.AssetFinanceDealGetPayload<{ select: typeof DEALER_DEAL_SELECT }>
type Person = { id: string; firstName: string; lastName: string; createdByDealerId: string | null }

const LENDER_ADDED = "A person added by the lender"
const BEFORE_SIGNING: readonly AssetDealStatus[] = ["DRAFT", "SUBMITTED", "REFERRED", "APPROVED"]

function summary(row: ListRow) {
  return {
    id: row.id,
    reference: row.application.reference,
    createdAt: row.createdAt.toISOString(),
    dealerSubmittedAt: row.dealerSubmittedAt?.toISOString() ?? null,
    borrower: row.entity?.legalName ?? (row.client ? `${row.client.firstName} ${row.client.lastName}` : ""),
    asset: { make: row.asset.make, model: row.asset.model, year: row.asset.year, serialNumber: row.asset.serialNumber },
    contractType: row.contractType,
    status: dealerStatus(row.status, row.dealerSubmittedAt),
  }
}

export type DealerDealSummary = ReturnType<typeof summary>

/** The projection of one deal row; `dealerId` decides which people may be named. */
export function projectDealerDeal(row: Row, dealerId: string) {
  const name = (p: Person) => (p.createdByDealerId === dealerId ? `${p.firstName} ${p.lastName}` : LENDER_ADDED)
  const subjects: Person[] = row.client ? [row.client] : (row.entity?.relationships ?? []).map((r) => r.client)
  const unique = subjects.filter((p, i) => subjects.findIndex((q) => q.id === p.id) === i)
  const missing: string[] = BEFORE_SIGNING.includes(row.status)
    ? [
        ...unique.filter((p) => !row.dealerConsentAttestations.some((a) => a.clientId === p.id)).map((p) => `Consent: ${name(p)}`),
        ...row.dealerDocumentRequests.filter((r) => !r.fulfilledAt).map((r) => `Document: ${r.docType}`),
      ]
    : row.status === "CONTRACTED"
      ? row.checklist.filter((c) => c.required && !c.confirmedAt).map((c) => `Checklist: ${c.item}`)
      : []
  return {
    ...summary(row),
    financedAmountCents: row.application.appliedAmount,
    baseInstalmentCents: row.baseInstalmentCents,
    people: unique.map((p) => ({ name: name(p), consentAttested: row.dealerConsentAttestations.some((a) => a.clientId === p.id) })),
    missing,
    documentRequests: row.dealerDocumentRequests.map((r) => ({
      id: r.id, docType: r.docType, note: r.note, requestedAt: r.requestedAt.toISOString(), fulfilled: r.fulfilledAt !== null,
    })),
    documents: row.documents.map((d) => ({ id: d.id, docType: d.docType, fileName: d.fileName, uploadedAt: d.createdAt.toISOString() })),
    signing: row.signers.map((s) => ({ document: s.document, signerRole: s.role, signed: s.signedAt !== null || s.confirmedAt !== null })),
    booking: row.loan ? { loanReference: row.loan.reference, bookedOn: row.loan.startDate.toISOString().slice(0, 10) } : null,
    commission: row.dealerCommissionLines.map((l) => ({
      kind: l.kind, effectiveOn: l.effectiveOn.toISOString().slice(0, 10), netCents: l.netCents, vatCents: l.vatCents, grossCents: l.grossCents, reason: l.reason,
    })),
  }
}

export type DealerDealView = ReturnType<typeof projectDealerDeal>

export async function listDealerDeals(actor: DealerActor): Promise<DealerDealSummary[]> {
  const rows = await prisma.assetFinanceDeal.findMany({
    where: { tenantId: actor.tenantId, dealerId: actor.dealerId },
    select: DEALER_DEAL_LIST_SELECT,
    orderBy: { createdAt: "desc" },
    take: 500,
  })
  return rows.map(summary)
}

/** The dealer's own deal as it may see it, or null (404) for any other deal. */
export async function loadDealerDealView(actor: DealerActor, dealId: string): Promise<DealerDealView | null> {
  const row = await prisma.assetFinanceDeal.findFirst({ where: dealerDealWhere(actor, dealId), select: DEALER_DEAL_SELECT })
  return row ? projectDealerDeal(row, actor.dealerId) : null
}
