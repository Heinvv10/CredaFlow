// Read models for an asset-finance deal, shared by the API routes and the
// staff pages. Every query passes the tenant explicitly (pages run outside
// withTenantContext). JSON-safe: cents are numbers, Decimals strings, dates
// ISO strings (./big-cents.ts).
import type { AssetDealStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { figureFromDb } from "./big-cents"
import type { StructureTerms } from "./deal-input"
import type { Solved } from "./deal-structure"
import { DEAL_STRUCTURE_SELECT, solveStoredDeal, termsFromDeal } from "./deal-terms"
import { loadDealBureauResults, type DealBureauResult } from "./deal-bureau-results"
import { isoOfDbDate } from "./rates-store"

export interface DealPerson {
  clientId: string
  name: string
  role: string
  trusteeKind: string | null
}

export interface DealFinancialsView {
  periodEnd: string
  turnoverCents: number
  ebitdaCents: number
  totalAssetsCents: number
  totalLiabilitiesCents: number
  existingDebtServiceCents: number
  avgMonthlyCreditsCents: number
  returnedDebitsCount: number
  dscr: string | null
  gearing: string | null
  notes: string | null
  preparedById: string
  updatedAt: string
}

export interface DealDetail {
  id: string
  status: AssetDealStatus
  contractType: string
  createdAt: string
  baseInstalmentCents: number | null
  application: {
    id: string
    reference: string
    status: string
    ncaRegime: string | null
    ncaClassificationRule: string | null
    decisionReason: string | null
    appliedAmount: number
    appliedTermDays: number
  }
  /** A PENDING NCA → NON_NCA override awaits a second approver. */
  awaitingRegimeApproval: boolean
  pendingOverrideId: string | null
  entity: { id: string; legalName: string; type: string; registrationNumber: string }
  asset: { id: string; description: string; serialNumber: string; cashPriceExclVatCents: number; vatCents: number }
  supplier: { id: string; name: string }
  product: { id: string; name: string }
  terms: StructureTerms
  schedule: Solved
  financials: DealFinancialsView | null
  /** The entity's active SURETY relationships: a deal has no surety table of its own. */
  sureties: DealPerson[]
  directorsAndTrustees: DealPerson[]
  bureau: DealBureauResult[]
  decision: { decision: string | null; reasons: string[]; decidedById: string | null; decidedAt: string | null }
}

export interface DealListRow {
  id: string
  status: AssetDealStatus
  applicationReference: string
  entityName: string
  assetDescription: string
  financedAmountCents: number
  baseInstalmentCents: number | null
  createdAt: string
}

const personName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`

export async function loadDealList(tenantId: string): Promise<DealListRow[]> {
  const rows = await prisma.assetFinanceDeal.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      status: true,
      baseInstalmentCents: true,
      createdAt: true,
      application: { select: { reference: true, appliedAmount: true } },
      entity: { select: { legalName: true } },
      asset: { select: { make: true, model: true, year: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    applicationReference: r.application.reference,
    entityName: r.entity.legalName,
    assetDescription: `${r.asset.year} ${r.asset.make} ${r.asset.model}`,
    financedAmountCents: r.application.appliedAmount,
    baseInstalmentCents: r.baseInstalmentCents,
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function loadDealDetail(tenantId: string, dealId: string): Promise<DealDetail | null> {
  const deal = await prisma.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      id: true,
      status: true,
      contractType: true,
      createdAt: true,
      baseInstalmentCents: true,
      entityId: true,
      decision: true,
      decisionReasons: true,
      decidedById: true,
      decidedAt: true,
      ...DEAL_STRUCTURE_SELECT,
      application: {
        select: {
          id: true, reference: true, status: true, ncaRegime: true, ncaClassificationRule: true,
          decisionReason: true, appliedAmount: true, appliedTermDays: true,
          product: { select: { id: true, name: true } },
          ncaRegimeOverrides: { where: { status: "PENDING", toRegime: "NON_NCA" }, select: { id: true }, take: 1 },
        },
      },
      entity: { select: { id: true, legalName: true, type: true, registrationNumber: true } },
      asset: { select: { id: true, make: true, model: true, year: true, serialNumber: true, cashPriceExclVatCents: true, vatCents: true } },
      supplier: { select: { id: true, name: true } },
      financials: true,
    },
  })
  if (!deal) return null

  const people = await prisma.entityRelationship.findMany({
    where: { tenantId, entityId: deal.entityId, active: true, role: { in: ["SURETY", "DIRECTOR", "TRUSTEE"] } },
    orderBy: { createdAt: "asc" },
    select: { clientId: true, role: true, trusteeKind: true, client: { select: { firstName: true, lastName: true } } },
  })
  const toPerson = (p: (typeof people)[number]): DealPerson => ({
    clientId: p.clientId, name: personName(p.client), role: p.role, trusteeKind: p.trusteeKind,
  })
  const { application: app, financials: f, asset } = deal
  const pendingOverrideId = app.ncaRegimeOverrides[0]?.id ?? null

  return {
    id: deal.id,
    status: deal.status,
    contractType: deal.contractType,
    createdAt: deal.createdAt.toISOString(),
    baseInstalmentCents: deal.baseInstalmentCents,
    application: {
      id: app.id, reference: app.reference, status: app.status, ncaRegime: app.ncaRegime,
      ncaClassificationRule: app.ncaClassificationRule, decisionReason: app.decisionReason,
      appliedAmount: app.appliedAmount, appliedTermDays: app.appliedTermDays,
    },
    awaitingRegimeApproval: pendingOverrideId !== null && app.ncaRegime !== "NON_NCA",
    pendingOverrideId,
    entity: deal.entity,
    asset: {
      id: asset.id, description: `${asset.year} ${asset.make} ${asset.model}`, serialNumber: asset.serialNumber,
      cashPriceExclVatCents: asset.cashPriceExclVatCents, vatCents: asset.vatCents,
    },
    supplier: deal.supplier,
    product: app.product,
    terms: termsFromDeal(deal),
    schedule: await solveStoredDeal(prisma, tenantId, deal, asset),
    financials: f && {
      periodEnd: isoOfDbDate(f.periodEnd),
      turnoverCents: figureFromDb(f.turnoverCents),
      ebitdaCents: figureFromDb(f.ebitdaCents),
      totalAssetsCents: figureFromDb(f.totalAssetsCents),
      totalLiabilitiesCents: figureFromDb(f.totalLiabilitiesCents),
      existingDebtServiceCents: figureFromDb(f.existingDebtServiceCents),
      avgMonthlyCreditsCents: figureFromDb(f.avgMonthlyCreditsCents),
      returnedDebitsCount: f.returnedDebitsCount,
      dscr: f.dscr?.toFixed(4) ?? null,
      gearing: f.gearing?.toFixed(4) ?? null,
      notes: f.notes,
      preparedById: f.preparedById,
      updatedAt: f.updatedAt.toISOString(),
    },
    sureties: people.filter((p) => p.role === "SURETY").map(toPerson),
    directorsAndTrustees: people.filter((p) => p.role !== "SURETY").map(toPerson),
    bureau: await loadDealBureauResults(tenantId, app.id),
    decision: {
      decision: deal.decision,
      reasons: deal.decisionReasons,
      decidedById: deal.decidedById,
      decidedAt: deal.decidedAt?.toISOString() ?? null,
    },
  }
}
