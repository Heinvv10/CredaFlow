import type { BusinessEntityType, EntityRole, TrusteeKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { nullableFigureFromDb } from "./big-cents"
import { ENTITY_DOCUMENT_VIEW_SELECT, toEntityDocumentView, type EntityDocumentView } from "./entity-documents"

// Read models for a BusinessEntity, shared by the API routes and the pages so
// the two cannot disagree about what an entity shows. Every query passes the
// tenant explicitly: pages run without withTenantContext's frame.

export interface EntityCore {
  id: string
  type: BusinessEntityType
  legalName: string
  tradingName: string | null
  registrationNumber: string
  mastersReference: string | null
  vatNumber: string | null
  annualTurnover: number | null
  totalAssetValue: number | null
  financialYearEnd: string | null
  financialsEvidenceIds: string[]
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  province: string | null
  postalCode: string | null
  createdAt: string
  updatedAt: string
}

export interface EntityPerson {
  relationshipId: string
  clientId: string
  clientReference: string
  name: string
  role: EntityRole
  trusteeKind: TrusteeKind | null
  ownershipPct: string | null
  active: boolean
}

export interface EntityApplicationRow {
  id: string
  reference: string
  status: string
  appliedAmount: number
  ncaRegime: string | null
  createdAt: string
}

export interface EntityDealRow {
  id: string
  status: string
  contractType: string
  applicationReference: string
  assetDescription: string
  createdAt: string
}

export interface EntityLoanRow {
  id: string
  reference: string
  status: string
  principal: number
  outstandingPrincipal: number
  startDate: string
}

export interface EntityRecords {
  applications: EntityApplicationRow[]
  deals: EntityDealRow[]
  loans: EntityLoanRow[]
}

const ENTITY_CORE_SELECT = {
  id: true,
  type: true,
  legalName: true,
  tradingName: true,
  registrationNumber: true,
  mastersReference: true,
  vatNumber: true,
  annualTurnover: true,
  totalAssetValue: true,
  financialYearEnd: true,
  financialsEvidenceIds: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  province: true,
  postalCode: true,
  createdAt: true,
  updatedAt: true,
} as const

export async function loadEntityCore(tenantId: string, entityId: string): Promise<EntityCore | null> {
  const row = await prisma.businessEntity.findFirst({ where: { id: entityId, tenantId }, select: ENTITY_CORE_SELECT })
  if (!row) return null
  return {
    ...row,
    annualTurnover: nullableFigureFromDb(row.annualTurnover),
    totalAssetValue: nullableFigureFromDb(row.totalAssetValue),
    financialYearEnd: row.financialYearEnd?.toISOString().slice(0, 10) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function loadEntityPeople(tenantId: string, entityId: string): Promise<EntityPerson[]> {
  const rows = await prisma.entityRelationship.findMany({
    where: { tenantId, entityId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      clientId: true,
      role: true,
      trusteeKind: true,
      ownershipPct: true,
      active: true,
      client: { select: { reference: true, firstName: true, lastName: true } },
    },
  })
  return rows.map((r) => ({
    relationshipId: r.id,
    clientId: r.clientId,
    clientReference: r.client.reference,
    name: `${r.client.firstName} ${r.client.lastName}`,
    role: r.role,
    trusteeKind: r.trusteeKind,
    ownershipPct: r.ownershipPct?.toString() ?? null,
    active: r.active,
  }))
}

export async function loadEntityDocuments(tenantId: string, entityId: string): Promise<EntityDocumentView[]> {
  const rows = await prisma.entityDocument.findMany({
    where: { tenantId, entityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: ENTITY_DOCUMENT_VIEW_SELECT,
  })
  return rows.map(toEntityDocumentView)
}

/** The entity's applications, deals and loans: read-only lists. */
export async function loadEntityRecords(tenantId: string, entityId: string): Promise<EntityRecords> {
  const [applications, deals, loans] = await Promise.all([
    prisma.loanApplication.findMany({
      where: { tenantId, entityId },
      orderBy: { createdAt: "desc" },
      select: { id: true, reference: true, status: true, appliedAmount: true, ncaRegime: true, createdAt: true },
    }),
    prisma.assetFinanceDeal.findMany({
      where: { tenantId, entityId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        contractType: true,
        createdAt: true,
        application: { select: { reference: true } },
        asset: { select: { make: true, model: true, year: true } },
      },
    }),
    prisma.loan.findMany({
      where: { tenantId, entityId },
      orderBy: { startDate: "desc" },
      select: { id: true, reference: true, status: true, principal: true, outstandingPrincipal: true, startDate: true },
    }),
  ])
  return {
    applications: applications.map((a) => ({
      id: a.id,
      reference: a.reference,
      status: a.status,
      appliedAmount: Number(a.appliedAmount),
      ncaRegime: a.ncaRegime,
      createdAt: a.createdAt.toISOString(),
    })),
    deals: deals.map((d) => ({
      id: d.id,
      status: d.status,
      contractType: d.contractType,
      applicationReference: d.application.reference,
      assetDescription: `${d.asset.year} ${d.asset.make} ${d.asset.model}`,
      createdAt: d.createdAt.toISOString(),
    })),
    loans: loans.map((l) => ({
      id: l.id,
      reference: l.reference,
      status: l.status,
      principal: Number(l.principal),
      outstandingPrincipal: Number(l.outstandingPrincipal),
      startDate: l.startDate.toISOString().slice(0, 10),
    })),
  }
}
