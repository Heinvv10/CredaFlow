/**
 * Fresh-database proof of the asset-finance demo seed (prisma/seed/
 * asset-finance.ts): on a database migrated from scratch, `npm run seed:base`
 * leaves (a) the trust's NCA finance lease, (b) the natural-person NCA
 * instalment sale and (c) the company's NON_NCA deal booked, with the entity
 * deals part-paid by early receipts and every four-eyes step taken by two different
 * staff users and the known synthetic portal logins working, and (d) the three
 * lease deals of prisma/seed/asset-finance-leases.ts with their servicing
 * (claims, readings, a termination quote, an elected end of term). Rerun
 * idempotency is proved, for the whole seed, by prisma/seed.integration.test.ts,
 * and for the leases here (a second seed leaves every lease count unchanged).
 *
 * Self-contained like that suite: it creates, migrates, seeds and drops its
 * own seed_af_it_<hex> database, so the role in DATABASE_URL needs CREATEDB.
 *
 *   RUN_SEED_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run prisma/seed-asset-finance.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PORTAL_AUTHORITY_ROLES } from "@/lib/asset-finance/portal-access"
import { sastCalendarDate } from "@/lib/date/sast"

const RUN = process.env.RUN_SEED_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const STAFF = (local: string) => `${local}@acme-lending.example`

// Chosen for this run through the env, as an operator would; never in source.
const PORTAL_PASSWORDS = {
  SEED_AF_TRUSTEE_PASSWORD: `it-trustee-${randomUUID()}`,
  SEED_AF_DIRECTOR_PASSWORD: `it-director-${randomUUID()}`,
  SEED_AF_SURETY_PASSWORD: `it-surety-${randomUUID()}`,
}

suite("asset-finance demo seed on a fresh migrated database", () => {
  const admin = RUN ? new PrismaClient() : null
  const name = `seed_af_it_${randomBytes(6).toString("hex")}`
  let db: PrismaClient | null = null
  const fresh = () => {
    if (!db) throw new Error("RUN_SEED_DB_IT=1 is required")
    return db
  }
  let seedEnv: NodeJS.ProcessEnv = process.env
  const userId = async (local: string) => (await fresh().user.findUniqueOrThrow({ where: { email: STAFF(local) } })).id

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${name}`
    const env = { ...process.env, DATABASE_URL: url.toString(), ...PORTAL_PASSWORDS }
    seedEnv = env
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

  it("(a) books the two-natural-trustee trust through the entity-NCA finance-lease path", async () => {
    const trust = await fresh().businessEntity.findFirstOrThrow({
      where: { type: "TRUST" },
      include: { relationships: true, documents: true },
    })
    expect(trust.relationships.map((r) => [r.role, r.trusteeKind])).toEqual([["TRUSTEE", "NATURAL"], ["TRUSTEE", "NATURAL"]])
    expect(trust.documents.find((d) => d.docType === "LETTERS_OF_AUTHORITY")?.verifiedAt).not.toBeNull()
    const deal = await fresh().assetFinanceDeal.findFirstOrThrow({ where: { entityId: trust.id, contractType: "FINANCE_LEASE" }, include: { application: true, loan: true } })
    expect(deal.status).toBe("BOOKED")
    expect(deal.application).toMatchObject({
      status: "DISBURSED", ncaRegime: "NCA", ncaClassificationRule: "TRUST_FEW_NATURAL_TRUSTEES",
      creditLifeElection: "DECLINED",
    })
    expect(deal.loan).toMatchObject({ ncaRegime: "NCA", contractType: "FINANCE_LEASE", balloonAmount: 6_900_000, clientId: null, entityId: trust.id })
    expect(await fresh().auditLog.count({ where: { entityId: deal.id, action: "ASSET_DEAL_BOOKED" } })).toBe(1)
  })

  it("(b) books the company's excavator deal: NON_NCA by an approved override, signed, paid out with four eyes", async () => {
    const company = await fresh().businessEntity.findFirstOrThrow({ where: { type: "COMPANY" } })
    expect(company.annualTurnover).toBe(BigInt(2_500_000_000))
    const deal = await fresh().assetFinanceDeal.findFirstOrThrow({
      where: { entityId: company.id, contractType: "INSTALMENT_SALE" },
      include: { application: true, payout: true, signers: { include: { client: true } }, asset: true },
    })
    expect(deal).toMatchObject({ status: "BOOKED", structurePreset: "ANNUAL_SEASONAL", rateBasis: "PRIME", balloonCents: 34_500_000, decision: "APPROVE" })
    expect(deal.asset).toMatchObject({ assetClass: "EXCAVATOR", cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, vin: "MBX00000000000001" })
    expect(deal.application).toMatchObject({ status: "DISBURSED", ncaRegime: "NON_NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" })
    const override = await fresh().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: deal.applicationId } })
    expect(override).toMatchObject({ status: "APPROVED", requestedById: await userId("credit.officer"), decidedById: await userId("loan.admin.two") })
    expect(deal.decidedById).toBe(await userId("loan.admin.one"))

    const signers = deal.signers.map((s) => [s.client.lastName, s.document, s.method]).sort()
    expect(signers).toEqual([
      ["Molefe", "SURETYSHIP", "WET_INK"], ["Mthethwa", "AGREEMENT", "E_SIGN"],
      ["Mthethwa", "RESOLUTION", "E_SIGN"], ["Mthethwa", "SURETYSHIP", "E_SIGN"],
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

  it("books the natural-person asset deal through PASQ, accepted credit life and NCA signing", async () => {
    const client = await fresh().client.findUniqueOrThrow({ where: { reference: "CLI-SEED-AF-0003" } })
    const deal = await fresh().assetFinanceDeal.findFirstOrThrow({
      where: { clientId: client.id },
      include: { application: true, loan: true },
    })
    expect(deal).toMatchObject({ status: "BOOKED", contractType: "INSTALMENT_SALE" })
    expect(deal.application).toMatchObject({ status: "DISBURSED", ncaRegime: "NCA", creditLifeElection: "ACCEPTED" })
    expect(deal.application.pasqAcknowledgedSha256).toBe(deal.application.pasqDocumentSha256)
    expect(deal.loan).toMatchObject({ ncaRegime: "NCA", contractType: "INSTALMENT_SALE", entityId: null, clientId: client.id })
    expect(await fresh().insurancePolicy.count({ where: { linkedLoanId: deal.loanId } })).toBe(1)
  })

  it("(b) the loan is booked today and part-paid by an early receipt of instalment 1, with no arrears", async () => {
    const company = await fresh().businessEntity.findFirstOrThrow({ where: { type: "COMPANY" } })
    const loan = await fresh().loan.findFirstOrThrow({
      where: { entityId: company.id, contractType: "INSTALMENT_SALE" },
      include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } }, payments: true, taxInvoices: { include: { lines: true } }, contractRates: true },
    })
    expect(loan).toMatchObject({ ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE", balloonAmount: 34_500_000, status: "ACTIVE", clientId: null })
    expect(loan.repaymentSchedule).toHaveLength(60)
    expect(loan.contractRates.map((r) => [r.basis, r.margin?.toString(), r.resultingRate.toString()])).toEqual([["PRIME", "0.01", "0.1175"]])
    const [invoice] = loan.taxInvoices
    expect(invoice).toMatchObject({ totalExclVatCents: 150_000_000, vatCents: 22_500_000, totalInclVatCents: 172_500_000 })
    expect(invoice.lines).toHaveLength(1)
    // Booked through the normal rules: the loan starts today (SAST), the supply date with it.
    const today = sastCalendarDate(new Date())
    expect(sastCalendarDate(loan.startDate)).toBe(today)
    expect(invoice.supplyDate.toISOString().slice(0, 10)).toBe(today)

    const [first, ...rest] = loan.repaymentSchedule
    expect(sastCalendarDate(first.dueDate) > today).toBe(true)
    expect(loan.payments.map((p) => [p.amount, p.allocationStatus])).toEqual([[first.totalDue, "ALLOCATED"]])
    expect(first).toMatchObject({ status: "PAID", totalPaid: first.totalDue })
    expect(rest.every((r) => r.status === "PENDING" && r.totalPaid === 0)).toBe(true)
    expect(loan.totalPaid).toBe(first.totalDue)
    expect(loan.outstandingPrincipal).toBe(loan.principal - first.principalDue)
    expect([loan.arrearsAmount, loan.daysInArrears]).toEqual([0, 0])
    expect(loan.nextPaymentDate?.getTime()).toBe(rest[0].dueDate.getTime())
  })

  it("seeds trustee and director entity access, while a surety has no entity access", async () => {
    const company = await fresh().businessEntity.findFirstOrThrow({ where: { type: "COMPANY" } })
    const trust = await fresh().businessEntity.findFirstOrThrow({ where: { type: "TRUST" } })
    for (const [email, password, entities] of [
      ["johan.botha@acme-lending.invalid", PORTAL_PASSWORDS.SEED_AF_TRUSTEE_PASSWORD, [trust.id]],
      ["nandi.mthethwa@acme-lending.invalid", PORTAL_PASSWORDS.SEED_AF_DIRECTOR_PASSWORD, [company.id]],
      ["kagiso.molefe@acme-lending.invalid", PORTAL_PASSWORDS.SEED_AF_SURETY_PASSWORD, []],
    ] as const) {
      const client = await fresh().client.findFirstOrThrow({ where: { email } })
      expect(await bcrypt.compare(password, client.portalPassword ?? "")).toBe(true)
      expect(client.kycStatus).toBe("PENDING")
      const authority = await fresh().entityRelationship.findMany({
        where: { clientId: client.id, active: true, role: { in: [...PORTAL_AUTHORITY_ROLES] } },
        select: { entityId: true },
      })
      expect([...new Set(authority.map((r) => r.entityId))]).toEqual(entities)
    }
  })

  const leaseLoan = (contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE", who: { entityType?: "COMPANY" | "TRUST"; soleProprietor?: true }) =>
    fresh().loan.findFirstOrThrow({
      where: { contractType, ...(who.soleProprietor ? { entityId: null } : { entity: { type: who.entityType } }) },
      include: {
        assetFinanceDeal: { include: { asset: true } }, application: true, payments: true,
        leaseRentals: { orderBy: { periodNo: "asc" }, include: { taxInvoice: true } },
        maintenanceFund: { include: { movements: true, claims: { orderBy: { createdAt: "asc" } } } },
        meterReadings: { orderBy: { value: "asc" } }, leaseTerminationQuotes: true,
        leaseEndOfTerm: { include: { damageItems: true, finalReading: true } },
      },
    })

  it("(d1) the company's full-maintenance lease of a TLB: lender risk, three rentals paid and invoiced, two claims and readings", async () => {
    const loan = await leaseLoan("FULL_MAINTENANCE_LEASE", { entityType: "COMPANY" })
    expect(loan).toMatchObject({ status: "ACTIVE", ncaRegime: "NON_NCA", cpaApplies: false, clientId: null })
    expect(loan.application).toMatchObject({ status: "DISBURSED", ncaClassificationRule: "LEASE_NOT_CREDIT_AGREEMENT" })
    expect(loan.assetFinanceDeal).toMatchObject({ status: "BOOKED", maintenanceRiskModel: "LENDER_RISK", usageUnit: "HOURS" })
    expect(loan.assetFinanceDeal?.asset.assetClass).toBe("TLB")
    expect(loan.leaseRentals).toHaveLength(36)
    const invoiced = loan.leaseRentals.filter((r) => r.taxInvoiceId !== null)
    expect(invoiced.map((r) => r.periodNo)).toEqual([1, 2, 3])
    expect(invoiced.every((r) => r.taxInvoice?.totalInclVatCents === r.totalCents)).toBe(true)
    expect(loan.payments).toHaveLength(3)
    // A receipt is never refused for its invoice: a refusal is only audited, so look for one.
    expect(await fresh().auditLog.count({ where: { action: "LEASE_INVOICE_REFUSED" } })).toBe(0)

    const fund = loan.maintenanceFund
    expect(fund?.riskModel).toBe("LENDER_RISK")
    const maintenance = invoiced.reduce((sum, r) => sum + r.maintenanceExclVatCents, 0)
    const movements = fund?.movements ?? []
    expect(movements.filter((m) => m.kind === "CONTRIBUTION")).toHaveLength(3)
    expect(movements.filter((m) => m.kind === "CLAIM").map((m) => m.amountCents)).toEqual([320_000])
    expect(maintenance - 320_000).toBe(1_030_000)
    const claims = fund?.claims ?? []
    expect(claims.map((c) => [c.status, c.amountExclVatCents])).toEqual([["PAID", 320_000], ["SUBMITTED", 185_000]])
    const [paid, open] = claims
    expect(paid.submittedById).toBe(await userId("credit.officer"))
    expect(paid.approvedById).not.toBe(paid.submittedById)
    expect(paid.paymentReference).toBe("PAY-CLAIM-0001")
    expect([open.approvedById, open.firstApprovedById]).toEqual([null, null])

    expect(loan.meterReadings.map((r) => [r.value, r.source])).toEqual([[40, "STAFF"], [52, "STAFF"], [58, "STAFF"], [61, "PORTAL"]])
    expect(paid.meterReadingId).toBe(loan.meterReadings[1].id)
  })

  it("(d2) the sole proprietor's operating lease of a registered bakkie: CPA applies, one rental invoiced, a termination quote still QUOTED", async () => {
    const loan = await leaseLoan("OPERATING_LEASE", { soleProprietor: true })
    expect(loan).toMatchObject({ status: "ACTIVE", cpaApplies: true, entityId: null })
    expect(loan.assetFinanceDeal).toMatchObject({ status: "BOOKED", cpaRule: "CPA_NATURAL_PERSON" })
    expect(loan.assetFinanceDeal?.asset).toMatchObject({ assetClass: "LIGHT_COMMERCIAL", registrationNumber: "KDW001GP" })
    expect(loan.leaseRentals).toHaveLength(36)
    expect(loan.leaseRentals.filter((r) => r.taxInvoiceId !== null).map((r) => r.periodNo)).toEqual([1])
    expect(loan.leaseRentals.some((r) => r.cancelledAt !== null)).toBe(false)
    expect(loan.maintenanceFund).toBeNull()
    expect(loan.leaseTerminationQuotes).toHaveLength(1)
    const [quote] = loan.leaseTerminationQuotes
    expect(quote).toMatchObject({ status: "QUOTED", cpaCancellation: true, acceptedAt: null, taxInvoiceId: null })
    expect(quote.remainingRentals).toBeGreaterThan(0)
    expect(quote.totalCents).toBe(quote.invoiceExclVatCents + quote.invoiceVatCents)
    expect(loan.leaseEndOfTerm).toBeNull()
    const lessee = await fresh().client.findUniqueOrThrow({ where: { id: loan.clientId ?? "" } })
    expect(lessee.email.endsWith(".invalid")).toBe(true)
  })

  it("(d3) the trust's full-maintenance lease at end of term: RETURN elected, the inspection waiting for the term's end", async () => {
    const loan = await leaseLoan("FULL_MAINTENANCE_LEASE", { entityType: "TRUST" })
    expect(loan).toMatchObject({ status: "ACTIVE", clientId: null })
    expect(loan.assetFinanceDeal).toMatchObject({ status: "BOOKED", maintenanceRiskModel: "LESSEE_SETTLED" })
    expect(loan.leaseRentals).toHaveLength(5)
    expect(loan.leaseRentals.filter((r) => r.taxInvoiceId !== null)).toHaveLength(1)
    const end = loan.leaseEndOfTerm
    expect(end).toMatchObject({ origin: "EXPIRY", outcome: "RETURN", status: "ELECTED", inspectedOn: null, finalReadingId: null, taxInvoiceId: null })
    expect(end?.electedById).toBe(await userId("credit.officer"))
    expect(end?.damageItems).toEqual([])
    expect(loan.maintenanceFund).toMatchObject({ riskModel: "LESSEE_SETTLED", settledAt: null })
    expect(loan.assetFinanceDeal?.asset.lessorStatus).not.toBe("RETURNED_TO_STOCK")
  })

  it("(e) takes the TLB through its legal matter and an s131 recovery to a shortfall, and lists the company lease's voluntary recovery", async () => {
    const tlb = await fresh().recovery.findFirstOrThrow({
      where: { route: "NCA_S131_ATTACHMENT" },
      include: { legalMatter: { include: { steps: { orderBy: { stepDate: "asc" } } } }, sales: true, vatEvents: true, loan: true, asset: true, costs: true },
    })
    // R6,500 storage, deducted from the R400,000 price.
    expect(tlb).toMatchObject({ status: "SHORTFALL_OPEN", surplusCents: 0, grossProceedsCents: 40_000_000, deductedCostsCents: 650_000, chargedCostsCents: 0, netProceedsCents: 39_350_000 })
    expect(tlb.shortfallCents).toBe(tlb.settlementDueCents! - 39_350_000)
    expect(tlb.costs).toMatchObject([{ type: "STORAGE", status: "APPROVED", grossCents: 650_000, recordedById: await userId("credit.officer"), approvedById: await userId("loan.admin.one") }])
    expect(tlb.finalNoticePath).not.toBeNull()
    expect(tlb.chargesFrozenUntil).not.toBeNull()
    expect(tlb.legalMatter?.steps.map((step) => step.kind)).toEqual(["S129_SENT", "SUMMONS_ISSUED", "SUMMONS_SERVED", "JUDGMENT", "ATTACHMENT_ORDER", "ASSET_RECOVERED"])
    expect(tlb.legalMatter?.attorneySupplierId).not.toBeNull()
    expect(tlb.loan).toMatchObject({ status: "ACTIVE", collectionsStage: "ATTORNEY_REFERRED" })
    expect(tlb.asset.lessorStatus).toBe("SOLD_IN_REMARKETING")
    // Sold under the valuation, so the second admin approved it.
    expect(tlb.sales).toHaveLength(1)
    expect(tlb.sales[0]).toMatchObject({ status: "COMPLETED", belowValuation: true, createdById: await userId("credit.officer"), approvedById: await userId("loan.admin.one") })
    expect(tlb.vatEvents.map((event) => event.kind)).toEqual(["REPOSSESSION_DEEMED_SUPPLY"])
    const lease = await fresh().recovery.findFirstOrThrow({ where: { route: "NON_NCA_VOLUNTARY" }, include: { loan: true } })
    expect(lease).toMatchObject({ status: "LISTED" })
    expect(lease.loan.contractType).toBe("FULL_MAINTENANCE_LEASE")
    expect(lease.valuationId).not.toBeNull()
    expect(await fresh().recoveryCost.findMany({ where: { recoveryId: lease.id } })).toMatchObject([{ type: "STORAGE", status: "APPROVED", grossCents: 420_000 }])
  })

  // A prospect is shown these records: fictional names, never "TEST" or "Synthetic".
  it("labels no asset-finance record a prospect sees TEST or Synthetic", async () => {
    const tables = [
      "BusinessEntity", "EntityRelationship", "EntityDocument", "FinancedAsset", "AssetValuation", "Supplier", "SupplierBankAccount",
      "AssetFinanceDeal", "EntityFinancials", "AssetFinanceAffordabilityAssessment", "DealSigner", "PayoutChecklistItem", "Payout",
      "MaintenanceClaim", "LegalMatter", "LegalMatterStep", "Recovery", "RecoveryCost", "RemarketingSale", "Client", "Payment",
    ]
    const hits: string[] = []
    for (const table of tables) {
      const rows = await fresh().$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t WHERE row_to_json(t)::text ~ '\\mTEST\\M' OR row_to_json(t)::text ~* 'synthetic'`,
      )
      for (const r of rows) hits.push(`${table}: ${r.row.slice(0, 160)}`)
    }
    expect(hits).toEqual([])
  })

  it("a second seed run leaves every lease and recovery count unchanged", async () => {
    const snapshot = async () => ({
      leases: await fresh().loan.count({ where: { contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } } }),
      leaseDeals: await fresh().assetFinanceDeal.count({ where: { contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } } }),
      rentals: await fresh().leaseRental.count(),
      rentalsInvoiced: await fresh().leaseRental.count({ where: { taxInvoiceId: { not: null } } }),
      payments: await fresh().payment.count(),
      funds: await fresh().maintenanceFund.count(),
      fundMovements: await fresh().maintenanceFundMovement.count(),
      claims: await fresh().maintenanceClaim.count(),
      readings: await fresh().assetMeterReading.count(),
      quotes: await fresh().leaseTerminationQuote.count(),
      endsOfTerm: await fresh().leaseEndOfTerm.count(),
      damageItems: await fresh().leaseDamageItem.count(),
      taxInvoices: await fresh().taxInvoice.count(),
      documents: await fresh().entityDocument.count(),
      clients: await fresh().client.count(),
      products: await fresh().loanProduct.count(),
      assets: await fresh().financedAsset.count(),
      audit: await fresh().auditLog.count(),
      legalMatters: await fresh().legalMatter.count(),
      legalSteps: await fresh().legalMatterStep.count(),
      recoveries: await fresh().recovery.count(),
      recoveryCosts: await fresh().recoveryCost.count(),
      sales: await fresh().remarketingSale.count(),
      vatEvents: await fresh().recoveryVatEvent.count(),
      valuations: await fresh().assetValuation.count(),
      suppliers: await fresh().supplier.count(),
      section129Records: await fresh().complianceRecord.count({ where: { type: "SECTION_129_NOTICE" } }),
    })
    const before = await snapshot()
    expect(before).toMatchObject({ leases: 3, leaseDeals: 3, rentals: 77, rentalsInvoiced: 5, claims: 2, readings: 5, quotes: 1, endsOfTerm: 1, damageItems: 0, funds: 2, legalMatters: 1, legalSteps: 6, recoveries: 2, recoveryCosts: 2, sales: 1, vatEvents: 1, valuations: 2, section129Records: 1 })
    execFileSync("npm", ["run", "seed:base", "--silent"], { cwd: process.cwd(), env: seedEnv, stdio: ["ignore", "pipe", "pipe"] })
    expect(await snapshot()).toEqual(before)
  }, 240_000)
})
