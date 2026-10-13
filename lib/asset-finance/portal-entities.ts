import type { BusinessEntityType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { authorisedEntityIdsForClient } from "./portal-access"
import { loadEntityRecords, type EntityRecords } from "./entity-detail"

// What a portal client sees of an entity they may act for. Deliberately
// narrower than the staff view: no other people, no financial figures, no
// verifier ids. The caller has already checked authority
// (requirePortalEntityAccess); these loaders only read.

export interface PortalEntitySummary {
  id: string
  type: BusinessEntityType
  legalName: string
  tradingName: string | null
  registrationNumber: string
}

export interface PortalEntityView extends EntityRecords {
  entity: PortalEntitySummary
}

const SUMMARY_SELECT = { id: true, type: true, legalName: true, tradingName: true, registrationNumber: true } as const

/** The entities this client may act for, for the entity switcher. */
export async function loadPortalEntities(tenantId: string, clientId: string): Promise<PortalEntitySummary[]> {
  const ids = await authorisedEntityIdsForClient(tenantId, clientId)
  if (ids.length === 0) return []
  return prisma.businessEntity.findMany({
    where: { tenantId, id: { in: ids } },
    orderBy: { legalName: "asc" },
    select: SUMMARY_SELECT,
  })
}

export async function loadPortalEntityView(tenantId: string, entityId: string): Promise<PortalEntityView | null> {
  const entity = await prisma.businessEntity.findFirst({ where: { id: entityId, tenantId }, select: SUMMARY_SELECT })
  if (!entity) return null
  return { entity, ...(await loadEntityRecords(tenantId, entityId)) }
}
