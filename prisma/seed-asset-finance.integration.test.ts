/**
 * Fresh-database proof of the asset-finance demo seed (prisma/seed/
 * asset-finance.ts): on a database migrated from scratch, `npm run seed:base`
 * leaves (a) the trust's deal refused as NCA and (b) the company's deal
 * booked and part-paid, with every four-eyes step taken by two different
 * staff users and the known synthetic portal logins working. Rerun
 * idempotency is proved, for the whole seed, by prisma/seed.integration.test.ts.
 *
 * Self-contained like that suite: it creates, migrates, seeds and drops its
 * own seed_af_it_<hex> database, so the role in DATABASE_URL needs CREATEDB.
 *
 *   RUN_SEED_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run prisma/seed-asset-finance.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ncaRefusalReason } from "@/lib/asset-finance/deal-submit"
import { PORTAL_AUTHORITY_ROLES } from "@/lib/asset-finance/portal-access"
import { sastCalendarDate } from "@/lib/date/sast"

const RUN = process.env.RUN_SEED_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const STAFF = (local: string) => `${local}@acme-lending.example`

suite("asset-finance demo seed on a fresh migrated database", () => {
  const admin = RUN ? new PrismaClient() : null
  const name = `seed_af_it_${randomBytes(6).toString("hex")}`
  let db: PrismaClient | null = null
  const fresh = () => {
    if (!db) throw new Error("RUN_SEED_DB_IT=1 is required")
    return db
  }
  const userId = async (local: string) => (await fresh().user.findUniqueOrThrow({ where: { email: STAFF(local) } })).id

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${name}`
    const env = { ...process.env, DATABASE_URL: url.toString() }
    execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] })
    execFileSync("npm", ["run", "seed:base", "--silent"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] })
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  }, 240_000)

  afterAll(async () => {
    await db?.$disconnect()
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin?.$disconnect()
  })

  it("turns the flag on, configures VAT and approves PRIME with four eyes", async () => {
    const tenant = await fresh().tenant.findUniqueOrThrow({ where: { slug: "acme" }, include: { config: true } })
    expect(tenant.config?.featureAssetFinance).toBe(true)
    expect(await fresh().vatConfig.findUniqueOrThrow({ where: { tenantId: tenant.id } })).toMatchObject({
      vatNumber: "4999999999", registeredName: tenant.config?.legalName,
    })
    const prime = await fresh().referenceRate.findFirstOrThrow({ where: { tenantId: tenant.id, basis: "PRIME" } })
    expect(prime).toMatchObject({ status: "APPROVED", requestedById: await userId("loan.admin.one"), decidedById: await userId("loan.admin.two") })
    const product = await fresh().loanProduct.findFirstOrThrow({ where: { tenantId: tenant.id, code: "AF-IS" } })
    expect([product.nonNcaDefaultInterestMargin?.toString(), product.nonNcaCollectionFeeCents]).toEqual(["0.02", 25_000])
    const account = await fresh().supplierBankAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })
    expect(account).toMatchObject({ status: "APPROVED", avsPassed: null, requestedById: await userId("credit.officer"), decidedById: await userId("loan.admin.one") })
    expect(account.avsResult).toMatchObject({ status: "NOT_RUN" })
  })

  it("(a) refuses the two-natural-trustee trust's deal as NCA, with the slice-1 reason, audited", async () => {
    const trust = await fresh().businessEntity.findFirstOrThrow({
      where: { type: "TRUST" },
      include: { relationships: true, documents: true },
    })
    expect(trust.relationships.map((r) => [r.role, r.trusteeKind])).toEqual([["TRUSTEE", "NATURAL"], ["TRUSTEE", "NATURAL"]])
    expect(trust.documents.find((d) => d.docType === "LETTERS_OF_AUTHORITY")?.verifiedAt).not.toBeNull()
    const deal = await fresh().assetFinanceDeal.findFirstOrThrow({ where: { entityId: trust.id }, include: { application: true } })
    expect(deal.status).toBe("REFUSED_NCA")
    expect(deal.application).toMatchObject({
      status: "DECLINED", ncaRegime: "NCA", ncaClassificationRule: "TRUST_FEW_NATURAL_TRUSTEES",
      decisionReason: ncaRefusalReason("TRUST_FEW_NATURAL_TRUSTEES"),
    })
    expect(await fresh().auditLog.count({ where: { entityId: deal.id, action: "ASSET_DEAL_REFUSED_NCA" } })).toBe(1)
  })

  it("(b) books the company's excavator deal: NON_NCA by an approved override, signed, paid out with four eyes", async () => {
    const company = await fresh().businessEntity.findFirstOrThrow({ where: { type: "COMPANY" } })
    expect(company.annualTurnover).toBe(BigInt(2_500_000_000))
    const deal = await fresh().assetFinanceDeal.findFirstOrThrow({
      where: { entityId: company.id },
      include: { application: true, payout: true, signers: { include: { client: true } }, asset: true },
    })
    expect(deal).toMatchObject({ status: "BOOKED", structurePreset: "ANNUAL_SEASONAL", rateBasis: "PRIME", balloonCents: 34_500_000, decision: "APPROVE" })
    expect(deal.asset).toMatchObject({ assetClass: "EXCAVATOR", cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, vin: "TEST0000000000001" })
    expect(deal.application).toMatchObject({ status: "DISBURSED", ncaRegime: "NON_NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" })
    const override = await fresh().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: deal.applicationId } })
    expect(override).toMatchObject({ status: "APPROVED", requestedById: await userId("credit.officer"), decidedById: await userId("loan.admin.two") })
    expect(deal.decidedById).toBe(await userId("loan.admin.one"))

    const signers = deal.signers.map((s) => [s.client.lastName, s.document, s.method]).sort()
    expect(signers).toEqual([
      ["Director One", "AGREEMENT", "E_SIGN"], ["Director One", "RESOLUTION", "E_SIGN"],
      ["Director One", "SURETYSHIP", "E_SIGN"], ["Surety One", "SURETYSHIP", "WET_INK"],
    ])
    const wetInk = deal.signers.find((s) => s.method === "WET_INK")
    expect(wetInk?.scanUploadedById).toBe(await userId("credit.officer"))
    expect(wetInk?.confirmedById).toBe(await userId("loan.admin.one"))
    expect(deal.payout).toMatchObject({
      status: "RELEASED", amountCents: 155_250_000, dualApprovalRequired: true,
      createdById: await userId("loan.admin.one"), approvedById: await userId("loan.admin.two"),
    })
    expect(await fresh().payoutChecklistItem.count({ where: { dealId: deal.id, required: true, confirmedAt: null } })).toBe(0)
  })

  it("(b) the loan is part-paid through receipts, with the next instalment in arrears", async () => {
    const loan = await fresh().loan.findFirstOrThrow({
      where: { entityId: { not: null } },
      include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } }, payments: true, taxInvoices: { include: { lines: true } }, contractRates: true },
    })
    expect(loan).toMatchObject({ ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE", balloonAmount: 34_500_000, status: "ACTIVE", clientId: null })
    expect(loan.repaymentSchedule).toHaveLength(60)
    expect(loan.contractRates.map((r) => [r.basis, r.margin?.toString(), r.resultingRate.toString()])).toEqual([["PRIME", "0.01", "0.1175"]])
    const [invoice] = loan.taxInvoices
    expect(invoice).toMatchObject({ totalExclVatCents: 150_000_000, vatCents: 22_500_000, totalInclVatCents: 172_500_000 })
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.supplyDate.toISOString().slice(0, 10)).toBe(sastCalendarDate(loan.startDate))
    expect(invoice.supplyDate.toISOString().slice(0, 10) < sastCalendarDate(new Date())).toBe(true)

    const paid = loan.repaymentSchedule.slice(0, 3)
    expect(loan.payments.map((p) => p.amount).sort()).toEqual(paid.map((r) => r.totalDue).sort())
    expect(paid.every((r) => r.status === "PAID")).toBe(true)
    expect(loan.totalPaid).toBe(paid.reduce((s, r) => s + r.totalDue, 0))
    expect(loan.arrearsAmount).toBe(loan.repaymentSchedule[3].totalDue)
    expect(loan.daysInArrears).toBeGreaterThan(0)
  })

  it("seeds the director's portal login (entity access) and the surety's (no entity access) with the documented passwords", async () => {
    const company = await fresh().businessEntity.findFirstOrThrow({ where: { type: "COMPANY" } })
    for (const [email, password, entities] of [
      ["test.director.one@acme-lending.invalid", "Synthetic-AF-Director-2099!", [company.id]],
      ["test.surety.one@acme-lending.invalid", "Synthetic-AF-Surety-2099!", []],
    ] as const) {
      const client = await fresh().client.findUniqueOrThrow({ where: { email } })
      expect(await bcrypt.compare(password, client.portalPassword ?? "")).toBe(true)
      expect(client.kycStatus).toBe("PENDING")
      const authority = await fresh().entityRelationship.findMany({
        where: { clientId: client.id, active: true, role: { in: [...PORTAL_AUTHORITY_ROLES] } },
        select: { entityId: true },
      })
      expect([...new Set(authority.map((r) => r.entityId))]).toEqual(entities)
    }
  })
})
