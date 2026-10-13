/**
 * Real-Postgres fixture for the asset-finance deal suites: a tenant with the
 * flag on, staff, an asset-finance product, an APPROVED PRIME reference rate, a
 * supplier, three assets, an unevidenced company (classifier → NCA) and an
 * evidenced R2m-turnover company (classifier → NON_NCA) with a consenting
 * director. Every value is synthetic. The route helpers call the real
 * handlers through a host that resolves to the tenant.
 */
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { POST as createRoute } from "@/app/api/asset-finance/deals/route"
import { POST as previewRoute } from "@/app/api/asset-finance/deals/preview/route"
import { POST as submitRoute } from "@/app/api/asset-finance/deals/[id]/submit/route"
import { POST as decideRoute } from "@/app/api/asset-finance/deals/[id]/decide/route"
import { POST as bureauRoute } from "@/app/api/asset-finance/deals/[id]/bureau-checks/route"
import { PUT as financialsRoute } from "@/app/api/asset-finance/deals/[id]/financials/route"
import { POST as decideOverrideRoute } from "@/app/api/asset-finance/nca-overrides/[overrideId]/decide/route"

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
}

export async function createDealFixture(db: PrismaClient, t: string): Promise<DealFixture> {
  const tenantId = `t_af_deal_${t}`
  const host = `af-deal-${t}.deal-it.test`
  await db.tenant.create({ data: { id: tenantId, slug: `af-deal-${t}`, name: "Deal IT", domain: host } })
  await db.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
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
  const supplier = await db.supplier.create({ data: { tenantId, name: "TEST Plant Sales (Pty) Ltd" } })
  const assets: string[] = []
  for (let i = 1; i <= 3; i++) {
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
    data: { tenantId, type: "COMPANY", legalName: "TEST Unproven Haulage (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/01` },
  })
  const evidenced = await db.businessEntity.create({
    data: {
      tenantId, type: "COMPANY", legalName: "TEST Earthmoving (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/02`,
      annualTurnover: 200_000_000, financialYearEnd: new Date("2026-02-28T00:00:00Z"), financialsEvidenceIds: [`afs-${t}`],
    },
  })
  const director = await db.client.create({
    data: {
      tenantId, firstName: "TEST", lastName: "Director", email: `director-${t}@client.invalid`, phone: `0000${t.slice(0, 6)}`,
      idNumber: "8001015009087", popiaConsentGiven: true,
    },
  })
  await db.entityRelationship.create({ data: { tenantId, entityId: evidenced.id, clientId: director.id, role: "DIRECTOR" } })
  return {
    tenantId, host,
    officer, adminA, adminB,
    product: product.id, supplier: supplier.id, assets,
    unevidenced: unevidenced.id, evidenced: evidenced.id, director: director.id,
  }
}

/** Removes the fixture's rows; overrides and decided applications need triggers off for it. */
export async function cleanupDealFixture(db: PrismaClient, fx: DealFixture | undefined): Promise<void> {
  if (!fx) return
  const tenantId = fx.tenantId
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.auditLog.deleteMany({ where: { tenantId } }),
    db.complianceRecord.deleteMany({ where: { tenantId } }),
    db.creditBureauCheck.deleteMany({ where: { tenantId } }),
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
    db.loanProduct.deleteMany({ where: { tenantId } }),
    db.tenantConfig.deleteMany({ where: { tenantId } }),
    db.user.deleteMany({ where: { tenantId } }),
    db.tenant.deleteMany({ where: { id: tenantId } }),
  ])
}

export function dealRoutes(host: string) {
  const request = (path: string, method: string, body: unknown) => new NextRequest(`http://${host}${path}`, {
    method,
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const id = (value: string) => ({ params: Promise.resolve({ id: value }) })
  return {
    preview: (body: unknown) => previewRoute(request("/api/asset-finance/deals/preview", "POST", body)),
    create: (body: unknown) => createRoute(request("/api/asset-finance/deals", "POST", body)),
    submit: (dealId: string) => submitRoute(request(`/api/asset-finance/deals/${dealId}/submit`, "POST", {}), id(dealId)),
    bureau: (dealId: string) => bureauRoute(request(`/api/asset-finance/deals/${dealId}/bureau-checks`, "POST", {}), id(dealId)),
    financials: (dealId: string, body: unknown) =>
      financialsRoute(request(`/api/asset-finance/deals/${dealId}/financials`, "PUT", body), id(dealId)),
    decide: (dealId: string, body: unknown) => decideRoute(request(`/api/asset-finance/deals/${dealId}/decide`, "POST", body), id(dealId)),
    decideOverride: (overrideId: string, body: unknown) =>
      decideOverrideRoute(request(`/api/asset-finance/nca-overrides/${overrideId}/decide`, "POST", body), {
        params: Promise.resolve({ overrideId }),
      }),
  }
}
