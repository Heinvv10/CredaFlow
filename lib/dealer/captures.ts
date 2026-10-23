/**
 * What a dealer has captured itself, for the new-deal wizard to pick from
 * again: its own entities (with the people it added to them), its own people
 * and its own assets. Only rows carrying this dealer's createdByDealerId, and
 * only what the dealer typed in: a person the lender linked to the entity is
 * counted, never named (spec deviation 25).
 */
import { prisma } from "@/lib/prisma"
import { CLOSED_DEAL_STATUSES } from "@/lib/asset-finance/deal-create"
import type { DealerActor } from "./actor"

const mine = (actor: Pick<DealerActor, "tenantId" | "dealerId">) => ({ tenantId: actor.tenantId, createdByDealerId: actor.dealerId })
/** A person or business the draft purge erased is gone: never offered again (lib/dealer/draft-purge.ts). */
const myParties = (actor: Pick<DealerActor, "tenantId" | "dealerId">) => ({ ...mine(actor), dealerPurgedAt: null })

export async function listDealerEntities(actor: DealerActor) {
  const rows = await prisma.businessEntity.findMany({
    where: myParties(actor),
    select: {
      id: true, type: true, legalName: true, registrationNumber: true,
      relationships: { where: { active: true }, select: { role: true, client: { select: { id: true, firstName: true, lastName: true, createdByDealerId: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
  return rows.map((row) => {
    const own = row.relationships.filter((r) => r.client.createdByDealerId === actor.dealerId)
    const people = new Map<string, { id: string; name: string; roles: string[] }>()
    for (const r of own) {
      const person = people.get(r.client.id) ?? { id: r.client.id, name: `${r.client.firstName} ${r.client.lastName}`, roles: [] }
      person.roles.push(r.role)
      people.set(r.client.id, person)
    }
    const lenderAdded = new Set(row.relationships.filter((r) => r.client.createdByDealerId !== actor.dealerId).map((r) => r.client.id)).size
    return { id: row.id, type: row.type, legalName: row.legalName, registrationNumber: row.registrationNumber, people: [...people.values()], lenderAddedPeople: lenderAdded }
  })
}

export async function listDealerPeople(actor: DealerActor) {
  const rows = await prisma.client.findMany({
    where: myParties(actor),
    select: { id: true, firstName: true, lastName: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
  return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}` }))
}

/** The dealer's assets free to finance: unreleased and on no open deal (createDeal refuses the rest). */
export function listDealerAssets(actor: DealerActor) {
  return prisma.financedAsset.findMany({
    where: { ...mine(actor), releasedAt: null, deals: { none: { status: { notIn: [...CLOSED_DEAL_STATUSES] } } } },
    select: { id: true, assetClass: true, make: true, model: true, year: true, serialNumber: true, cashPriceExclVatCents: true, vatCents: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
}
