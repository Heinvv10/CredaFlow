/**
 * Real-Postgres fixture for the asset-finance deal suites: a tenant with the
 * flag on, staff, an asset-finance product, an APPROVED PRIME reference rate, a
 * supplier, four assets, an unevidenced company (classifier → NCA) and an
 * evidenced R2m-turnover company (classifier → NON_NCA) with a consenting
 * director. Every value is synthetic. The route helpers call the real
 * handlers through a host that resolves to the tenant.
 */
import type { PrismaClient } from "@prisma/client"
import { unlink } from "node:fs/promises"
import { NextRequest } from "next/server"
import { POST as createRoute } from "@/app/api/asset-finance/deals/route"
import { POST as previewRoute } from "@/app/api/asset-finance/deals/preview/route"
import { POST as submitRoute } from "@/app/api/asset-finance/deals/[id]/submit/route"
import { POST as decideRoute } from "@/app/api/asset-finance/deals/[id]/decide/route"
import { POST as bureauRoute } from "@/app/api/asset-finance/deals/[id]/bureau-checks/route"
import { PUT as financialsRoute } from "@/app/api/asset-finance/deals/[id]/financials/route"
import { PUT as affordabilityRoute } from "@/app/api/asset-finance/deals/[id]/affordability/route"
import { POST as decideOverrideRoute } from "@/app/api/asset-finance/nca-overrides/[overrideId]/decide/route"
import { POST as creditLifeRoute } from "@/app/api/portal/asset-finance/deals/[id]/credit-life/route"
import { POST as ncaQuoteRoute } from "@/app/api/asset-finance/deals/[id]/nca-quote/route"
import { POST as pasqAcknowledgeRoute } from "@/app/api/applications/[id]/pasq/acknowledge/route"
import { GET as documentViewRoute } from "@/app/api/documents/[id]/view/route"
import { POST as ncaAgreementRoute } from "@/app/api/asset-finance/deals/[id]/nca-agreement/route"
import { POST as ncaAgreementSignRoute } from "@/app/api/portal/asset-finance/deals/[id]/nca-agreement/sign/route"
import { POST as ncaAgreementCountersignRoute } from "@/app/api/asset-finance/deals/[id]/nca-agreement/countersign/route"
import { POST as bookRoute } from "@/app/api/asset-finance/deals/[id]/book/route"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"

/** Asset 1's registration number. */
export const ASSET_ONE_REGISTRATION = "TEST001GP"

export interface DealFixture {
  tenantId: string
  host: string
  officer: string
  adminA: string
  adminB: string
  product: string
  supplier: string
  assets: string[]
  unevidenced: string
  evidenced: string
  director: string
  directorEmail: string
}

/** The fixture's tenant id for run token `t`, known before setup so a partial setup is cleaned up too. */
export const dealFixtureTenantId = (t: string) => `t_af_deal_${t}`

export async function createDealFixture(db: PrismaClient, t: string): Promise<DealFixture> {
  const tenantId = dealFixtureTenantId(t)
  const host = `af-deal-${t}.deal-it.test`
  await db.tenant.create({ data: { id: tenantId, slug: `af-deal-${t}`, name: "Deal IT", domain: host } })
  await db.tenantConfig.create({ data: {
    tenantId, featureAssetFinance: true, legalName: "TEST Asset Credit (Pty) Ltd", brandName: "TEST Asset Credit",
    ncrNumber: "NCRCP99999", fscaNumber: "99999", companyRegNumber: "2099/000001/07",
    registeredOffice: "1 Synthetic Road\nJohannesburg", publicEmail: "hello@test.invalid", publicPhone: "+27110000000",
    collectionsEmail: "collections@test.invalid", collectionsPhone: "+27110000001",
  } })
  const user = async (label: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
    (await db.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })).id
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: `AF-${t}`, name: "TEST plant instalment sale", productType: "PERSONAL",
      minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650,
      interestRatePm: 1.0, interestModel: "DAILY_ACCRUAL",
    },
  })
  const officer = await user("officer", "CREDIT_OFFICER")
  const adminA = await user("admin-a", "LOAN_ADMIN")
  const adminB = await user("admin-b", "LOAN_ADMIN")
  // Four-eyes: only an APPROVED rate counts, decided by a second real user.
  const prime = await db.referenceRate.create({
    data: { tenantId, basis: "PRIME", effectiveDate: new Date("2020-01-01T00:00:00Z"), rate: "0.1075", requestedById: adminA },
  })
  await db.referenceRate.update({ where: { id: prime.id }, data: { status: "APPROVED", decidedById: adminB, decidedAt: new Date() } })
  const repo = await db.referenceRate.create({
    data: { tenantId, basis: "REPO", effectiveDate: new Date("2020-01-01T00:00:00Z"), rate: "0.0725", requestedById: adminA },
  })
  await db.referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: adminB, decidedAt: new Date() } })
  const supplier = await db.supplier.create({ data: { tenantId, name: "TEST Plant Sales (Pty) Ltd" } })
  const assets: string[] = []
  for (let i = 1; i <= 4; i++) {
    assets.push((await db.financedAsset.create({
      data: {
        tenantId, assetClass: "EXCAVATOR", make: "TEST", model: `EX-${i}`, year: 2025,
        serialNumber: `TEST${t.toUpperCase()}${i}`, cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
        // Asset 1 is registered (an eNaTIS item on its payout checklist). Identity is fixed from approval.
        registrationNumber: i === 1 ? ASSET_ONE_REGISTRATION : null,
      },
    })).id)
  }
  const unevidenced = await db.businessEntity.create({
    data: {
      tenantId, type: "COMPANY", legalName: "TEST Unproven Haulage (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/01`,
      addressLine1: "5 Synthetic Yard", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
    },
  })
  const evidenced = await db.businessEntity.create({
    data: {
      tenantId, type: "COMPANY", legalName: "TEST Earthmoving (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/02`,
      annualTurnover: 200_000_000, financialYearEnd: new Date("2026-02-28T00:00:00Z"), financialsEvidenceIds: [`afs-${t}`],
    },
  })
  const directorEmail = `director-${t}@client.invalid`
  const director = await db.client.create({
    data: {
      tenantId, firstName: "TEST", lastName: "Director", email: directorEmail, phone: `0000${t.slice(0, 6)}`,
      idNumber: syntheticSaIdNumber(), popiaConsentGiven: true,
      addressLine1: "7 Synthetic Close", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
    },
  })
  await db.entityRelationship.create({ data: { tenantId, entityId: evidenced.id, clientId: director.id, role: "DIRECTOR" } })
  await db.entityRelationship.create({ data: { tenantId, entityId: unevidenced.id, clientId: director.id, role: "DIRECTOR" } })
  return {
    tenantId, host,
    officer, adminA, adminB,
    product: product.id, supplier: supplier.id, assets,
    unevidenced: unevidenced.id, evidenced: evidenced.id, director: director.id, directorEmail,
  }
}

/**
 * Removes the fixture's rows by tenant, so it also cleans up after a setup
 * that failed part-way (pass `{ tenantId: dealFixtureTenantId(t) }`);
 * overrides and decided applications need triggers off for it.
 */
export async function cleanupDealFixture(db: PrismaClient, fx: Pick<DealFixture, "tenantId"> | undefined): Promise<void> {
  if (!fx) return
  const tenantId = fx.tenantId
  const documents = await db.clientDocument.findMany({ where: { tenantId }, select: { id: true, storagePath: true } })
  const invoices = await db.taxInvoice.findMany({ where: { tenantId }, select: { id: true } })
  const surrenders = await db.surrenderRequest.findMany({ where: { tenantId }, select: { id: true, valuationNoticePath: true, finalNoticePath: true } })
  const documentIds = documents.map((document) => document.id)
  await Promise.all(documents.flatMap((document) => document.storagePath ? [unlink(document.storagePath).catch(() => undefined)] : []))
  await Promise.all(surrenders.flatMap((row) => [row.valuationNoticePath, row.finalNoticePath].filter((path): path is string => !!path).map((path) => unlink(path).catch(() => undefined))))
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.documentAccessLog.deleteMany({ where: { documentId: { in: [...documentIds, ...invoices.map((invoice) => invoice.id)] } } }),
    db.documentAccessLog.deleteMany({ where: { documentId: { in: surrenders.flatMap((row) => [`${row.id}:valuation`, `${row.id}:final`]) } } }),
    db.taxInvoiceLine.deleteMany({ where: { invoice: { tenantId } } }),
    db.taxInvoice.deleteMany({ where: { tenantId } }),
    db.insurancePolicy.deleteMany({ where: { tenantId } }),
    db.payout.deleteMany({ where: { tenantId } }),
    db.payoutChecklistItem.deleteMany({ where: { tenantId } }),
    db.contractRate.deleteMany({ where: { tenantId } }),
    db.surrenderRequest.deleteMany({ where: { tenantId } }),
    db.assetValuation.deleteMany({ where: { tenantId } }),
    db.payment.deleteMany({ where: { tenantId } }),
    db.repaymentSchedule.deleteMany({ where: { tenantId } }),
    db.assetFinanceDeal.updateMany({ where: { tenantId }, data: { loanId: null } }),
    db.loan.deleteMany({ where: { tenantId } }),
    db.supplierBankAccount.deleteMany({ where: { tenantId } }),
    db.auditLog.deleteMany({ where: { tenantId } }),
    db.complianceRecord.deleteMany({ where: { tenantId } }),
    db.creditBureauCheck.deleteMany({ where: { tenantId } }),
    db.clientDocument.deleteMany({ where: { tenantId } }),
    db.assetFinanceAffordabilityAssessment.deleteMany({ where: { tenantId } }),
    db.entityFinancials.deleteMany({ where: { tenantId } }),
    db.assetFinanceDeal.deleteMany({ where: { tenantId } }),
    db.ncaRegimeOverride.deleteMany({ where: { tenantId } }),
    db.loanApplication.deleteMany({ where: { tenantId } }),
    db.entityRelationship.deleteMany({ where: { tenantId } }),
    db.client.deleteMany({ where: { tenantId } }),
    db.businessEntity.deleteMany({ where: { tenantId } }),
    db.financedAsset.deleteMany({ where: { tenantId } }),
    db.supplier.deleteMany({ where: { tenantId } }),
    db.referenceRate.deleteMany({ where: { tenantId } }),
    db.insuranceProduct.deleteMany({ where: { tenantId } }),
    db.insurer.deleteMany({ where: { tenantId } }),
    db.loanProduct.deleteMany({ where: { tenantId } }),
    db.vatConfig.deleteMany({ where: { tenantId } }),
    db.tenantConfig.deleteMany({ where: { tenantId } }),
    db.user.deleteMany({ where: { tenantId } }),
    db.tenant.deleteMany({ where: { id: tenantId } }),
  ])
}

export function dealRoutes(host: string) {
  const request = (path: string, method: string, body: unknown) => new NextRequest(`http://${host}${path}`, {
    method,
    headers: { host, "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
  })
  const id = (value: string) => ({ params: Promise.resolve({ id: value }) })
  return {
    preview: (body: unknown) => previewRoute(request("/api/asset-finance/deals/preview", "POST", body)),
    create: (body: unknown) => createRoute(request("/api/asset-finance/deals", "POST", body)),
    submit: (dealId: string) => submitRoute(request(`/api/asset-finance/deals/${dealId}/submit`, "POST", {}), id(dealId)),
    bureau: (dealId: string) => bureauRoute(request(`/api/asset-finance/deals/${dealId}/bureau-checks`, "POST", {}), id(dealId)),
    financials: (dealId: string, body: unknown) =>
      financialsRoute(request(`/api/asset-finance/deals/${dealId}/financials`, "PUT", body), id(dealId)),
    affordability: (dealId: string, body: unknown) =>
      affordabilityRoute(request(`/api/asset-finance/deals/${dealId}/affordability`, "PUT", body), id(dealId)),
    creditLife: (dealId: string, body: unknown) =>
      creditLifeRoute(request(`/api/portal/asset-finance/deals/${dealId}/credit-life`, "POST", body), id(dealId)),
    ncaQuote: (dealId: string) => ncaQuoteRoute(request(`/api/asset-finance/deals/${dealId}/nca-quote`, "POST", {}), id(dealId)),
    viewDocument: (documentId: string) => documentViewRoute(request(`/api/documents/${documentId}/view`, "GET", {}), id(documentId)),
    acknowledgePasq: (applicationId: string, body: unknown) =>
      pasqAcknowledgeRoute(request(`/api/applications/${applicationId}/pasq/acknowledge`, "POST", body), id(applicationId)),
    ncaAgreement: (dealId: string) => ncaAgreementRoute(request(`/api/asset-finance/deals/${dealId}/nca-agreement`, "POST", {}), id(dealId)),
    signNcaAgreement: (dealId: string, body: unknown) =>
      ncaAgreementSignRoute(request(`/api/portal/asset-finance/deals/${dealId}/nca-agreement/sign`, "POST", body), id(dealId)),
    countersignNcaAgreement: (dealId: string, body: unknown) =>
      ncaAgreementCountersignRoute(request(`/api/asset-finance/deals/${dealId}/nca-agreement/countersign`, "POST", body), id(dealId)),
    book: (dealId: string) => bookRoute(request(`/api/asset-finance/deals/${dealId}/book`, "POST", {}), id(dealId)),
    decide: (dealId: string, body: unknown) => decideRoute(request(`/api/asset-finance/deals/${dealId}/decide`, "POST", body), id(dealId)),
    decideOverride: (overrideId: string, body: unknown) =>
      decideOverrideRoute(request(`/api/asset-finance/nca-overrides/${overrideId}/decide`, "POST", body), {
        params: Promise.resolve({ overrideId }),
      }),
  }
}
