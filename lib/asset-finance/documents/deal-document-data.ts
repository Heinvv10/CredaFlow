// Everything the deal documents print, read from the database in one place
// (goal §4.9). The renderers (./agreement-pdf.ts, ./suretyship-pdf.ts,
// ./resolution-pdf.ts) are pure functions of this shape, so the same data
// renders the same bytes and a sha256 binds what a signer saw.
//
// Lender identity comes from getLenderIdentity: an unconfigured identity
// throws LenderIdentityError and the documents refuse to render, as the NCA
// documents do (lib/pdf/.claude.md). The schedule is the deal's stored
// structure solved at the reference rate in effect on its start date
// (./../deal-structure.ts); an unsolvable structure refuses too.
import type { BusinessEntityType, Prisma, ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { getLenderIdentity, type LenderIdentity } from "@/lib/config/identity"
import type { ScheduleRow } from "../types"
import { ASSET_CLASS_LABELS } from "../asset-labels"
import { DEAL_STRUCTURE_SELECT, solveStoredDeal } from "../deal-terms"
import { deriveRequiredSigners, type RequiredSigner } from "../signing"

export class DealDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DealDocumentError"
  }
}

export interface DocumentPerson {
  clientId: string
  name: string
  idNumber: string
}

export interface DealDocumentData {
  /** TenantConfig.assetFinanceLegalWordingApproved; false prints the DRAFT watermark. */
  legalWordingApproved: boolean
  /** The credit decision's instant: the document date and the PDF metadata dates. */
  documentDate: Date
  reference: string
  lender: Pick<LenderIdentity, "legalName" | "tradingName" | "companyRegNumber" | "ncrNumber" | "registeredOfficeLines">
  entity: {
    type: BusinessEntityType
    legalName: string
    tradingName: string | null
    registrationNumber: string
    mastersReference: string | null
    vatNumber: string | null
    addressLines: string[]
  }
  asset: {
    classLabel: string
    make: string
    model: string
    year: number
    serialNumber: string
    vin: string | null
    engineNumber: string | null
    registrationNumber: string | null
  }
  supplier: { name: string; registrationNumber: string | null; vatNumber: string | null }
  pricing: {
    cashPriceExclVatCents: number
    vatCents: number
    depositCents: number
    tradeInCents: number
    financedFeesCents: number
    balloonCents: number
    financedAmountCents: number
    baseInstalmentCents: number
    totalInterestCents: number
    totalPayableCents: number
    rateBasis: ReferenceRateBasis
    rateMargin: string | null
    fixedRate: string | null
    annualRate: string
    reference: { effectiveDate: string; rate: string } | null
    structurePreset: string
    startDate: string
  }
  schedule: ScheduleRow[]
  /** Who signs the agreement and the resolution. */
  signatories: DocumentPerson[]
  sureties: DocumentPerson[]
  requiredSigners: RequiredSigner[]
}

export type DocumentDataDb = Pick<
  typeof prisma,
  "assetFinanceDeal" | "entityRelationship" | "tenantConfig" | "referenceRate" | "contractRate"
>

const person = (c: { id: string; firstName: string; lastName: string; idNumber: string }): DocumentPerson => ({
  clientId: c.id,
  name: `${c.firstName} ${c.lastName}`,
  idNumber: c.idNumber,
})

/** null when the deal is not this tenant's. Throws DealDocumentError / LenderIdentityError when it cannot render. */
export async function loadDealDocumentData(db: DocumentDataDb, tenantId: string, dealId: string): Promise<DealDocumentData | null> {
  const deal = await db.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      decidedAt: true,
      entityId: true,
      ...DEAL_STRUCTURE_SELECT,
      application: { select: { reference: true } },
      entity: true,
      asset: true,
      supplier: { select: { name: true, registrationNumber: true, vatNumber: true } },
    },
  })
  if (!deal) return null
  if (!deal.decidedAt) throw new DealDocumentError("The deal has no credit decision; its documents cannot be rendered")

  const [lender, config, relationships] = await Promise.all([
    getLenderIdentity(tenantId),
    db.tenantConfig.findUnique({ where: { tenantId }, select: { assetFinanceLegalWordingApproved: true } }),
    db.entityRelationship.findMany({
      where: { tenantId, entityId: deal.entityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { clientId: true, role: true, active: true, client: { select: { id: true, firstName: true, lastName: true, idNumber: true } } },
    }),
  ])
  const solved = await solveStoredDeal(db, tenantId, deal, deal.asset)
  if (!solved.ok) throw new DealDocumentError(`The schedule cannot be solved: ${solved.error}`)

  const entityType = deal.entity.type
  const requiredSigners = deriveRequiredSigners(entityType, relationships)
  const people = new Map(relationships.map((r) => [r.clientId, person(r.client)]))
  const peopleFor = (document: RequiredSigner["document"]) =>
    requiredSigners.filter((s) => s.document === document).map((s) => people.get(s.clientId)).filter((p): p is DocumentPerson => p !== undefined)
  const e = deal.entity
  const a = deal.asset
  const r = solved.result

  return {
    legalWordingApproved: config?.assetFinanceLegalWordingApproved === true,
    documentDate: deal.decidedAt,
    reference: deal.application.reference,
    lender: {
      legalName: lender.legalName,
      tradingName: lender.tradingName,
      companyRegNumber: lender.companyRegNumber,
      ncrNumber: lender.ncrNumber,
      registeredOfficeLines: lender.registeredOfficeLines,
    },
    entity: {
      type: entityType,
      legalName: e.legalName,
      tradingName: e.tradingName,
      registrationNumber: e.registrationNumber,
      mastersReference: e.mastersReference,
      vatNumber: e.vatNumber,
      addressLines: [e.addressLine1, e.addressLine2, e.city, e.province, e.postalCode].filter((l): l is string => !!l && l.trim() !== ""),
    },
    asset: {
      classLabel: ASSET_CLASS_LABELS[a.assetClass],
      make: a.make,
      model: a.model,
      year: a.year,
      serialNumber: a.serialNumber,
      vin: a.vin,
      engineNumber: a.engineNumber,
      registrationNumber: a.registrationNumber,
    },
    supplier: deal.supplier,
    pricing: {
      cashPriceExclVatCents: a.cashPriceExclVatCents,
      vatCents: a.vatCents,
      depositCents: deal.depositCents,
      tradeInCents: deal.tradeInCents,
      financedFeesCents: deal.financedFeesCents,
      balloonCents: deal.balloonCents,
      financedAmountCents: r.financedAmountCents,
      baseInstalmentCents: r.baseInstalmentCents,
      totalInterestCents: r.totalInterestCents,
      totalPayableCents: r.totalPayableCents,
      rateBasis: deal.rateBasis,
      rateMargin: decimalString(deal.rateMargin),
      fixedRate: decimalString(deal.fixedRate),
      annualRate: solved.rate.annualRate,
      reference: solved.rate.reference,
      structurePreset: deal.structurePreset,
      startDate: solved.startDate,
    },
    schedule: r.rows,
    signatories: peopleFor("AGREEMENT"),
    sureties: peopleFor("SURETYSHIP"),
    requiredSigners,
  }
}

function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString()
}
