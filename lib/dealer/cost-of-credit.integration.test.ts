/**
 * NCA cost of credit untouched (SLICE5.md part A, §2a.5): commission is the
 * lender's cost, never a borrower charge. The same NCA sole-proprietor deal is
 * booked twice through the real routes, once originated by a dealer with a
 * commission rate of 2.50% + R1 500 (and earning that commission at booking)
 * and once by staff, on identical borrower and asset attributes, structure,
 * product and dates. The borrower's figures must be identical:
 *
 *   - the PASQ evidence (createAssetPasqEvidence / assetCalculatorEvidence,
 *     lib/asset-finance/nca-evidence.ts; calculatePasqTotalCostOfCreditCents,
 *     lib/compliance/pasq.ts): totalCostOfCreditCents, the calculator figures
 *     and schedule, billing and credit life;
 *   - the deal's solved and signed figures (solveWithRate /
 *     solveNcaDealStructure, deal-structure.ts / nca-structure.ts);
 *   - the Loan row and its schedule rows (planBooking, booking-plan.ts).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/cost-of-credit.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { publishStarterTemplates } from "@/lib/asset-finance/documents/templates/templates.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { dealRoutes } from "@/lib/asset-finance/deal.integration-fixture"
import { POST as verifyRoute } from "@/app/api/asset-finance/deals/[id]/dealer-consents/[attestationId]/verify/route"
import { POST as acceptRoute } from "@/app/api/asset-finance/deals/[id]/dealer-submission/accept/route"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, assetBody, createdId, dealBody, inTenant, pdfUpload, personBody } from "./dealer-origination.integration-fixture"
import { bookSubmittedNcaDeal, type SessionUser } from "./cost-of-credit.integration-fixture"
import { captureDealerAsset, captureDealerPerson } from "./capture"
import { createDealerDeal } from "./deals"
import { uploadDealerDocument } from "./documents"
import { attestDealerConsent } from "./consent"
import { submitDealerDeal } from "./submit"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const deals = { dealer: "", staff: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
  return db
}
const setSession = (user: SessionUser) => { session.current = { user } }
// Completed by staff on the dealer's minimal client, and the same on the staff client.
const BORROWER = {
  addressLine1: "7 Synthetic Close", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
  monthlyIncome: 12_000_000, monthlyExpenses: 3_000_000,
}
const staffPost = (path: string, run: (req: NextRequest) => Promise<Response>) =>
  run(new NextRequest(`http://${fx.host}${path}`, { method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: "{}" }))

/** Every borrower-facing figure of a booked deal, without the ids and the moments that differ by origination. */
async function borrowerFigures(dealId: string) {
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { application: true, loan: true } })
  const loan = deal.loan
  if (!loan) throw new Error(`deal ${dealId} is not booked`)
  const {
    id: _id, reference: _ref, applicationId: _app, clientId: _client, entityId: _entity, assetId: _asset,
    agreementDocId: _agreement, createdAt: _created, updatedAt: _updated, ...loanFigures
  } = loan
  const schedule = await database().repaymentSchedule.findMany({ where: { loanId: loan.id }, orderBy: { installmentNo: "asc" } })
  const pasq = deal.application.pasqEvidence as { totalCostOfCreditCents: number; calculator: unknown; billing: unknown; creditLife: Record<string, unknown>; termDays: number }
  return {
    pasq: {
      totalCostOfCreditCents: pasq.totalCostOfCreditCents, calculator: pasq.calculator, billing: pasq.billing, termDays: pasq.termDays,
      creditLife: { election: pasq.creditLife.election, totalPremiumCents: pasq.creditLife.totalPremiumCents, monthlyPremiumCents: pasq.creditLife.monthlyPremiumCents },
    },
    deal: {
      contractType: deal.contractType, baseInstalmentCents: deal.baseInstalmentCents, signedBaseInstalmentCents: deal.signedBaseInstalmentCents,
      signedResultingRate: String(deal.signedResultingRate), signedTotalInterestCents: deal.signedTotalInterestCents,
      signedCollectionFeeCents: deal.signedCollectionFeeCents, plannedStartDate: deal.plannedStartDate, firstDueDate: deal.firstDueDate,
    },
    application: { appliedAmount: deal.application.appliedAmount, approvedAmount: deal.application.approvedAmount, ncaRegime: deal.application.ncaRegime },
    loan: { ...loanFigures, interestRatePm: String(loanFigures.interestRatePm) },
    schedule: schedule.map(({ id: _row, loanId: _loan, ...row }) => row),
  }
}

suite.sequential("NCA cost of credit with and without a dealer (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createDealerFixture(database(), t)
    await publishStarterTemplates(database(), fx.tenantId, fx.adminA, fx.adminB)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetFinanceLegalWordingApproved: true } })
    await database().vatConfig.create({ data: {
      tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg",
    } })
    insertRate(fx, { dealerId: fx.dealerA, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
  }, 120_000)

  afterAll(async () => {
    session.current = null
    await cleanupDealerFixtureIfCreated(db, t)
  })

  it("originates the dealer deal: dealer capture, consent evidence, submit; staff verify and accept through the routes", async () => {
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    const { clientId, assetId, dealId } = await inTenant(fx, async () => {
      const clientId = createdId(await captureDealerPerson(sales, personBody()))
      const assetId = createdId(await captureDealerAsset(sales, assetBody()))
      const created = await createDealerDeal(sales, dealBody(fx, { clientId }, assetId))
      if (created.kind !== "created") throw new Error(JSON.stringify(created))
      return { clientId, assetId, dealId: created.dealId }
    })
    deals.dealer = dealId
    await database().client.update({ where: { id: clientId }, data: BORROWER })
    await inTenant(fx, async () => {
      const consent = await uploadDealerDocument(sales, dealId, pdfUpload("POPIA_CONSENT"))
      if (consent.kind !== "stored") throw new Error(consent.error)
      expect(await attestDealerConsent(sales, dealId, { documentId: consent.document.id, clientIds: [clientId] })).toMatchObject({ kind: "attested" })
      expect(await submitDealerDeal(sales, dealId)).toMatchObject({ kind: "submitted" })
    })
    setSession({ id: fx.officer, email: "officer@coc-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
    const attestation = await database().dealerConsentAttestation.findFirstOrThrow({ where: { dealId } })
    const verified = await staffPost(`/api/asset-finance/deals/${dealId}/dealer-consents/${attestation.id}/verify`,
      (req) => verifyRoute(req, { params: Promise.resolve({ id: dealId, attestationId: attestation.id }) }))
    expect(verified.status, await verified.clone().text()).toBe(200)
    const accepted = await staffPost(`/api/asset-finance/deals/${dealId}/dealer-submission/accept`,
      (req) => acceptRoute(req, { params: Promise.resolve({ id: dealId }) }))
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    expect(await database().financedAsset.findUniqueOrThrow({ where: { id: assetId }, select: { createdByDealerId: true } })).toEqual({ createdByDealerId: fx.dealerA })
  }, 60_000)

  it("originates the staff deal on identical attributes", async () => {
    const dealerClient = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: deals.dealer }, include: { client: true, asset: true } })
    const client = await database().client.create({ data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: "Director", email: `staff-borrower-${t}@client.invalid`, phone: "+27820000001",
      idNumber: syntheticSaIdNumber(), ...BORROWER,
    } })
    const source = dealerClient.asset
    const asset = await database().financedAsset.create({ data: {
      tenantId: fx.tenantId, assetClass: source.assetClass, make: source.make, model: source.model, year: source.year,
      serialNumber: `TESTSTAFF${t.toUpperCase()}`, cashPriceExclVatCents: source.cashPriceExclVatCents, vatCents: source.vatCents,
    } })
    setSession({ id: fx.officer, email: "officer@coc-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
    const created = await dealRoutes(fx.host).create(dealBody(fx, { clientId: client.id }, asset.id))
    expect(created.status, await created.clone().text()).toBe(201)
    deals.staff = ((await created.json()) as { id: string }).id
    expect((await dealRoutes(fx.host).submit(deals.staff)).status).toBe(200)
  })

  it("books both through the regulated NCA path", async () => {
    for (const dealId of [deals.dealer, deals.staff]) {
      const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { client: true, asset: true } })
      await bookSubmittedNcaDeal({
        db: database(), fx, dealId, client: { id: deal.client!.id, email: deal.client!.email! },
        serialNumber: deal.asset.serialNumber!, supplierAccountId: fx.supplierAccount, setSession,
      })
    }
    const statuses = await database().assetFinanceDeal.findMany({ where: { id: { in: [deals.dealer, deals.staff] } }, select: { status: true } })
    expect(statuses).toEqual([{ status: "BOOKED" }, { status: "BOOKED" }])
  }, 180_000)

  it("earned the dealer its commission (2.50% + R1 500 of the goods advance, plus VAT), and the staff deal none", async () => {
    const dealer = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: deals.dealer }, include: { asset: true } })
    expect(dealer).toMatchObject({ dealerCommissionSource: "DEALER", dealerCommissionBps: 250, dealerCommissionFlatCents: 150_000 })
    // The asset's cash price incl. VAT less the deposit and the trade-in: never the financed fees.
    const base = dealer.asset.cashPriceExclVatCents + dealer.asset.vatCents - dealer.depositCents - dealer.tradeInCents
    const lines = await database().dealerCommissionLine.findMany({ where: { dealId: { in: [deals.dealer, deals.staff] } } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ dealId: deals.dealer, kind: "EARNED", baseCents: base, netCents: Math.round(base * 250 / 10_000) + 150_000 })
    expect(lines[0].vatCents).toBeGreaterThan(0)
  })

  it("leaves every borrower figure identical: PASQ cost of credit and schedule, signed terms, Loan and its schedule rows", async () => {
    const [withDealer, withoutDealer] = [await borrowerFigures(deals.dealer), await borrowerFigures(deals.staff)]
    expect(withDealer.pasq.totalCostOfCreditCents).toBeGreaterThan(0)
    expect(withDealer.schedule.length).toBeGreaterThan(0)
    expect(withDealer).toEqual(withoutDealer)
  })
})
