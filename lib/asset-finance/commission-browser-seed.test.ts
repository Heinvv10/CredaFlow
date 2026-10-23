/**
 * Local synthetic browser-acceptance seed for SLICE5-FOLLOWUPS.md part W
 * (the introducer's commission disclosure); run explicitly on an owned
 * disposable database, never a shared one. How to run it:
 * docs/asset-finance/evidence/slice5-followups/browser/W/README.md.
 *
 * One demo-flagged lender whose templates are adopted, approved and published
 * (ensureSyntheticTemplates), so documents issue, with four APPROVED deals:
 * - isaDealer: a commercial instalment sale (a company) introduced by a DEALER,
 *   ready for staff to prepare documents;
 * - isaPlain: the same shape, no dealer;
 * - ncaBroker: an NCA instalment sale (a natural person) introduced by a
 *   BROKER, credit life elected, ready for staff to generate the NCA quotation;
 * - ncaPlain: the same, no broker.
 * The dealer and broker links are written as the dealer fixtures write
 * history (triggers off): the deals were approved before the introducer was
 * recorded. Two LOAN_ADMIN staff sign in with the shared password and TOTP; the
 * logins go to a local file (mode 600). Every value is synthetic.
 */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { insertDealer, insertDealerUser, lit } from "@/lib/dealer/dealer.integration-fixture"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"
import { sql } from "./af-sql.integration-fixture"
import { addMonthsClamped } from "./dates"
import { createDealFixture, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { SYNTHETIC_IDENTITY } from "./deal-signing.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const seed = process.env.WCOMMISSION_BROWSER_SEED === "1" ? it : it.skip
const OUT = process.env.WCOMMISSION_BROWSER_SEED_OUT || "/tmp/cf-commission-browser.json"
const PASSWORD = "Synthetic-Commission-2026!"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"
const DEALER_NAME = "SYNTHETIC Highveld Plant Dealers (Pty) Ltd"
const BROKER_NAME = "SYNTHETIC Karoo Finance Brokers CC"

seed("seeds the synthetic part W browser acceptance on an owned disposable PG", async () => {
  const db = new PrismaClient()
  try {
    const token = `wcomm${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const fx: DealFixture = await createDealFixture(db, token, { templates: false })
    const routes = dealRoutes(fx.host)
    const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
      session.current = { user: { id: userId, email: `${userId}@w-commission.test`, role, tenantId: fx.tenantId } }
    }
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { ...SYNTHETIC_IDENTITY, isDemoLender: true, assetFinanceLegalWordingApproved: false } })
    const hash = await bcrypt.hash(PASSWORD, 10)
    for (const id of [fx.officer, fx.adminA, fx.adminB]) {
      await db.user.update({ where: { id }, data: { password: hash, totpEnabled: true, totpSecret: TOTP_SECRET } })
    }
    // The lender's templates, approved by one admin and published by the other under the synthetic demo basis.
    await ensureSyntheticTemplates(fx.tenantId, {
      adminOne: { id: fx.adminA, email: `admin-a-${token}@staff.invalid` }, adminTwo: { id: fx.adminB, email: `admin-b-${token}@staff.invalid` },
    })
    // NCA deals need a credit-life product to elect.
    const insurer = await db.insurer.create({ data: { tenantId: fx.tenantId, name: "TEST Life Underwriter", fspNumber: "99999" } })
    await db.insuranceProduct.create({ data: {
      tenantId: fx.tenantId, code: `CL-${token}`, name: "TEST Asset Credit Life", type: "CREDIT_LIFE", premiumAmount: 1, sumAssured: 1, insurerId: insurer.id,
    } })
    const firstDueDate = addMonthsClamped(sastCalendarDate(new Date()), 2)
    const financials = {
      periodEnd: "2026-02-28", turnoverCents: 240_000_000, ebitdaCents: 80_000_000, totalAssetsCents: 300_000_000,
      totalLiabilitiesCents: 40_000_000, existingDebtServiceCents: 4_000_000, avgMonthlyCreditsCents: 20_000_000, returnedDebitsCount: 0,
    }

    /** A company's commercial instalment sale, taken to APPROVED the way the signing fixture does. */
    const approvedIsa = async (assetId: string): Promise<{ dealId: string; applicationId: string }> => {
      signIn(fx.officer, "CREDIT_OFFICER")
      const created = await routes.create({
        assetId, depositCents: 17_250_000, balloonCents: 20_000_000, firstDueDate, preset: { kind: "MONTHLY", periods: 36 },
        rateBasis: "PRIME", rateMargin: "0.0100", entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
      })
      expect(created.status).toBe(201)
      const dealId = ((await created.json()) as { id: string }).id
      expect((await routes.submit(dealId)).status).toBe(200)
      const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
      const override = await db.ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: deal.applicationId } })
      signIn(fx.adminB, "LOAN_ADMIN")
      expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
      signIn(fx.officer, "CREDIT_OFFICER")
      expect((await routes.financials(dealId, financials)).status).toBe(200)
      signIn(fx.adminA, "LOAN_ADMIN")
      expect((await routes.decide(dealId, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })).status).toBe(200)
      return { dealId, applicationId: deal.applicationId }
    }

    /** A natural person's NCA instalment sale, APPROVED with credit life elected: staff can generate the quotation. */
    const approvedNca = async (assetId: string, clientId: string, email: string): Promise<{ dealId: string; applicationId: string }> => {
      signIn(fx.officer, "CREDIT_OFFICER")
      const created = await routes.create({
        assetId, depositCents: 17_250_000, balloonCents: 0, firstDueDate, preset: { kind: "MONTHLY", periods: 60 },
        rateBasis: "PRIME", rateMargin: "0.0100", clientId, supplierId: fx.supplier, productId: fx.product,
      })
      expect(created.status).toBe(201)
      const dealId = ((await created.json()) as { id: string }).id
      expect((await routes.submit(dealId)).status).toBe(200)
      const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
      await db.loanApplication.update({ where: { id: deal.applicationId }, data: { affordabilityNDI: 80_000_000 } })
      expect((await routes.financials(dealId, financials)).status).toBe(200)
      signIn(fx.adminA, "LOAN_ADMIN")
      expect((await routes.affordability(dealId, { recklessLendingNote: "Verified business bank credits and personal NDI support the proposed instalment." })).status).toBe(200)
      session.current = { user: { id: clientId, email, role: "CLIENT", tenantId: fx.tenantId } }
      expect((await routes.creditLife(dealId, { election: "ACCEPTED" })).status).toBe(200)
      signIn(fx.adminA, "LOAN_ADMIN")
      expect((await routes.decide(dealId, { decision: "APPROVE", reasons: ["Affordable on verified business income and personal NDI"] })).status).toBe(200)
      return { dealId, applicationId: deal.applicationId }
    }

    /** History, as the dealer fixtures write it: the deal is the dealer's or broker's, handed over. */
    const introduce = (dealId: string, name: string, kind: "DEALER" | "BROKER"): string => {
      const dealerId = insertDealer(fx.tenantId, fx.adminA, { name })
      if (kind === "BROKER") sql(`UPDATE "Dealer" SET "kind" = 'BROKER' WHERE "id" = ${lit(dealerId)}`)
      const dealerUserId = insertDealerUser(fx.tenantId, dealerId, { byUser: fx.adminA })
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE "AssetFinanceDeal" SET "dealerId" = ${lit(dealerId)}, "dealerUserId" = ${lit(dealerUserId)}, "createdById" = ${lit(dealerUserId)},
          "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}; COMMIT;`)
      return dealerId
    }

    const isaDealer = await approvedIsa(fx.assets[0])
    const isaPlain = await approvedIsa(fx.assets[1])
    // One NCA deal per consumer and product: the second consumer is a copy of the first with its own identity number.
    const second = await db.client.create({ data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: "Consumer", email: `consumer-${token}@client.invalid`, phone: `0001${token.slice(0, 6)}`,
      idNumber: syntheticSaIdNumber(), popiaConsentGiven: true, addressLine1: "9 Synthetic Close", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
    } })
    const ncaBroker = await approvedNca(fx.assets[2], fx.director, fx.directorEmail)
    const ncaPlain = await approvedNca(fx.assets[3], second.id, second.email ?? "")
    introduce(isaDealer.dealId, DEALER_NAME, "DEALER")
    introduce(ncaBroker.dealId, BROKER_NAME, "BROKER")

    const deals = await db.assetFinanceDeal.findMany({
      where: { tenantId: fx.tenantId }, select: { id: true, status: true, contractType: true, dealer: { select: { name: true, kind: true } } },
    })
    const shape = Object.fromEntries(deals.map((d) => [d.id, { status: d.status, contractType: d.contractType, introducer: d.dealer ? `${d.dealer.name} (${d.dealer.kind})` : null }]))
    expect(Object.values(shape).map((d) => d.status)).toEqual(["APPROVED", "APPROVED", "APPROVED", "APPROVED"])
    expect(Object.values(shape).filter((d) => d.introducer !== null)).toHaveLength(2)
    expect(await db.documentTemplate.count({ where: { tenantId: fx.tenantId, kind: "ASSET_FINANCE", currentVersionId: { not: null } } })).toBeGreaterThanOrEqual(11)

    const entry = (deal: { dealId: string }, what: string, introducer: string | null, next: string) => ({
      dealId: deal.dealId, what, introducer, next, staffUrl: `/asset-finance/deals/${deal.dealId}`,
    })
    writeFileSync(OUT, JSON.stringify({
      tenantId: fx.tenantId, slug: `af-deal-${token}`, host: fx.host, password: PASSWORD, totpSecret: TOTP_SECRET,
      staff: (await db.user.findMany({ where: { id: { in: [fx.adminA, fx.adminB] } }, select: { email: true, role: true }, orderBy: { email: "asc" } })),
      deals: {
        isaDealer: entry(isaDealer, "commercial instalment sale (a company)", `${DEALER_NAME} (dealer)`, "prepare the signing documents; the agreement carries the Introducer row and paragraph"),
        isaPlain: entry(isaPlain, "commercial instalment sale (a company), no dealer", null, "prepare the signing documents; no Introducer row or paragraph"),
        ncaBroker: entry(ncaBroker, "NCA instalment sale (a natural person), credit life elected", `${BROKER_NAME} (broker)`, "generate the NCA quotation; the COMMISSION TO THE INTRODUCER section; then the agreement after the consumer acknowledges the quotation"),
        ncaPlain: entry(ncaPlain, "NCA instalment sale (a natural person), credit life elected, no broker", null, "generate the NCA quotation; no commission section"),
      },
      note: "Staff sign in with the shared password and the TOTP secret. The NCA agreement needs the consumer to acknowledge the quotation in the portal, which this seed does not set up.",
      shape,
    }, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 600_000)
