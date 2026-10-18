/**
 * Round-2 adversarial edge test: the NCA quotation-mark gate
 * (documents/templates/issuance.ts ncaQuoteMarkProblem) for a natural-person
 * NCA asset deal, through the real routes against a migrated Postgres. Only
 * the session is stubbed.
 *
 * The gate's stated purpose: an NCA agreement under a lender's legal approval
 * "may not follow a quotation still stamped DRAFT". It reads the lender's
 * flag at agreement time, not the mark of the quotation the consumer actually
 * acknowledged, so flipping the flag between quotation and agreement lets an
 * unwatermarked agreement follow a DRAFT-stamped quotation.
 *
 *   RUN_ASSET_TEMPLATES_EDGE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/edge-round2-nca-quote.integration.test.ts --testTimeout 60000 --no-file-parallelism
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addMonthsClamped } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { DRAFT_WATERMARK } from "./documents/pdf-layout"
import { texts } from "./documents/nca/nca-wording.test-helpers"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_EDGE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture
let dealId = ""
let quoteDocumentId = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_EDGE_IT=1 is required")
  return db
}
const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@edge2-it.test`, role, tenantId: fx.tenantId } }
}
const signInClient = (clientId: string) => {
  session.current = { user: { id: clientId, email: fx.directorEmail, role: "CLIENT", tenantId: fx.tenantId } }
}
const routes = () => dealRoutes(fx.host)

suite.sequential("EDGE round 2: NCA quotation-mark gate (real Postgres, real routes)", () => {
  beforeAll(async () => {
    // Every template published under the fixture's (test) legal approval; the
    // legacy quotation-wording flag stays OFF, so quotations print DRAFT.
    fx = await createDealFixture(database(), t)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetFinanceLegalWordingApproved: false } })
    const insurer = await database().insurer.create({ data: { tenantId: fx.tenantId, name: "TEST Life Underwriter", fspNumber: "99999" } })
    await database().insuranceProduct.create({ data: {
      tenantId: fx.tenantId, code: `CL-${t}`, name: "TEST Asset Credit Life", type: "CREDIT_LIFE", premiumAmount: 1, sumAssured: 1, insurerId: insurer.id,
    } })
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({
      assetId: fx.assets[3], depositCents: 17_250_000, balloonCents: 0, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2),
      preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100",
      clientId: fx.director, supplierId: fx.supplier, productId: fx.product,
    })
    expect(created.status).toBe(201)
    dealId = (await created.json()).id
    expect((await routes().submit(dealId)).status).toBe(200)
    const row = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
    await database().loanApplication.update({ where: { id: row.applicationId }, data: { affordabilityNDI: 80_000_000 } })
    expect((await routes().financials(dealId, {
      periodEnd: "2026-02-28", turnoverCents: 240_000_000, ebitdaCents: 80_000_000, totalAssetsCents: 300_000_000,
      totalLiabilitiesCents: 40_000_000, existingDebtServiceCents: 4_000_000, avgMonthlyCreditsCents: 20_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().affordability(dealId, { recklessLendingNote: "Verified business bank credits and personal NDI support the proposed instalment." })).status).toBe(200)
    signInClient(fx.director)
    expect((await routes().creditLife(dealId, { election: "ACCEPTED" })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().decide(dealId, { decision: "APPROVE", reasons: ["Affordable on verified business income and personal NDI"] })).status).toBe(200)
    const issued = await routes().ncaQuote(dealId)
    expect(issued.status).toBe(201)
    const quote = await issued.json() as { documentId: string; sha256: string }
    quoteDocumentId = quote.documentId
    signInClient(fx.director)
    expect((await routes().viewDocument(quote.documentId)).status).toBe(200)
    expect((await routes().acknowledgePasq(row.applicationId, { documentSha256: quote.sha256 })).status).toBe(200)
  }, 240_000)

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("GUARD: the consumer acknowledged a quotation stamped DRAFT, and with the flag off the legally approved agreement is refused", async () => {
    const quote = await database().clientDocument.findUniqueOrThrow({ where: { id: quoteDocumentId } })
    expect(await texts(await readFile(quote.storagePath!))).toContain(DRAFT_WATERMARK)
    signIn(fx.adminA, "LOAN_ADMIN")
    const refused = await routes().ncaAgreement(dealId)
    expect(refused.status).not.toBe(201)
    expect(JSON.stringify(await refused.json())).toMatch(/quotation wording is not yet approved/)
    expect(await database().assetDocumentIssuance.count({ where: { dealId } })).toBe(0)
  })

  it("DEFECT: turning the flag on after that quotation lets an unwatermarked agreement follow the DRAFT-stamped quotation the consumer acknowledged", async () => {
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetFinanceLegalWordingApproved: true } })
    signIn(fx.adminA, "LOAN_ADMIN")
    const response = await routes().ncaAgreement(dealId)
    const body = await response.json() as { documentId?: string }
    if (response.status === 201 && body.documentId) {
      const agreement = await database().clientDocument.findUniqueOrThrow({ where: { id: body.documentId } })
      const quote = await database().clientDocument.findUniqueOrThrow({ where: { id: quoteDocumentId } })
      const quoteDraft = (await texts(await readFile(quote.storagePath!))).includes(DRAFT_WATERMARK)
      const agreementDraft = (await texts(await readFile(agreement.storagePath!))).includes(DRAFT_WATERMARK)
      // The agreement must not be unmarked while the quotation it follows is DRAFT.
      expect({ quoteDraft, agreementDraft }).not.toEqual({ quoteDraft: true, agreementDraft: false })
    }
    expect(response.status, "issued an unwatermarked agreement after a DRAFT quotation").not.toBe(201)
  })
})
