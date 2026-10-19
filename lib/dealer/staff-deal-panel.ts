/**
 * The Dealer panel on the staff deal view: who originated the deal, when the
 * dealer handed it over (the staff "accept" then runs submitDeal), the people
 * the dealer captured with their contact details to verify, the dealer's
 * consent attestations awaiting staff verification, the document requests,
 * the commission snapshot taken at approval and the deal's commission lines.
 * Null for a deal staff originated.
 */
import { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "@/lib/asset-finance/dates"

const NAME = { select: { name: true, email: true } } as const
const CONTACT = {
  select: {
    id: true, firstName: true, lastName: true, email: true, phone: true, createdByDealerId: true,
    dealerContactVerifiedAt: true, dealerContactVerifiedBy: NAME,
  },
} as const

export async function loadDealDealerPanel(tenantId: string, dealId: string) {
  const deal = await prisma.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId, dealerId: { not: null } },
    select: {
      id: true, status: true, dealerSubmittedAt: true,
      dealerCommissionSource: true, dealerCommissionBps: true, dealerCommissionFlatCents: true,
      dealerCommissionBaseCents: true, dealerCommissionSnapshotAt: true,
      dealer: { select: { id: true, name: true, kind: true, active: true } },
      dealerUser: { select: { name: true, email: true } },
      client: CONTACT,
      entity: { select: { relationships: { where: { active: true }, select: { client: CONTACT } } } },
      dealerConsentAttestations: {
        orderBy: { attestedAt: "asc" },
        select: {
          id: true, attestedAt: true, verifiedAt: true, statementVersion: true,
          client: { select: { firstName: true, lastName: true } },
          document: { select: { id: true, fileName: true, deletedAt: true } },
          dealerUser: NAME, verifiedBy: NAME,
        },
      },
      dealerDocumentRequests: {
        orderBy: { requestedAt: "asc" },
        select: { id: true, docType: true, note: true, requestedAt: true, fulfilledAt: true, requestedBy: NAME, fulfilledDocumentId: true },
      },
      dealerCommissionLines: {
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, reason: true, effectiveOn: true, netCents: true, vatCents: true, grossCents: true },
      },
    },
  })
  if (!deal?.dealer) return null
  const { client, entity, ...rest } = deal
  const people = client ? [client] : (entity?.relationships ?? []).map((r) => r.client)
  return {
    ...rest,
    dealer: deal.dealer,
    // Only the people this dealer captured: their contact details are untrusted until verified.
    dealerPeople: people.filter((p, i) => p.createdByDealerId !== null && people.findIndex((q) => q.id === p.id) === i),
    dealerCommissionLines: deal.dealerCommissionLines.map((line) => ({ ...line, effectiveOn: isoOfDbDate(line.effectiveOn) })),
  }
}

export type DealDealerPanel = NonNullable<Awaited<ReturnType<typeof loadDealDealerPanel>>>
