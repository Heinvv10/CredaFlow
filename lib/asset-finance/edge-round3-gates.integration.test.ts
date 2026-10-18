/**
 * Round-3 adversarial edge tests (built on the round-2 setup): the NCA
 * quotation-mark gate now reading the acknowledged quotation's audit row, and
 * the protected-output fingerprint binding. DEFECT tests failed on
 * feat/lender-owned-templates 1a68ba62 and are FIXED since round 3 (the NCA
 * agreement is published after this deal's DRAFT quotation: while a legally
 * approved one is published, such a quotation is now refused up front).
 *
 * Original round-2 header follows.
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
 *     npx vitest run lib/asset-finance/edge-round3-gates.integration.test.ts --testTimeout 60000 --no-file-parallelism
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addMonthsClamped } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { starterContent } from "./documents/templates/content"
import { parseTemplateKey } from "./documents/templates/families"
import { selectIssuableTemplate } from "./documents/templates/issuance"
import { createDraftVersion, publishVersion } from "./documents/templates/store"
import { publishStarterTemplates, FIXTURE_SIGN_OFF_REFERENCE, legalApprover } from "./documents/templates/templates.integration-fixture"

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
const sqlError = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  return null
}

suite.sequential("EDGE round 3: quotation gate and fingerprint (real Postgres, real routes)", () => {
  beforeAll(async () => {
    // Every template but the NCA agreement published under the fixture's (test)
    // legal approval; the legacy quotation-wording flag stays OFF, so quotations print DRAFT.
    fx = await createDealFixture(database(), t, { templates: false })
    await publishStarterTemplates(database(), fx.tenantId, fx.adminA, fx.adminB, ["af.isa", "af.lease.operating", "af.lease.fml", "af.suretyship", "af.resolution"])
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

    signInClient(fx.director)
    expect((await routes().viewDocument(quote.documentId)).status).toBe(200)
    expect((await routes().acknowledgePasq(row.applicationId, { documentSha256: quote.sha256 })).status).toBe(200)
    await publishStarterTemplates(database(), fx.tenantId, fx.adminA, fx.adminB, ["af.nca"])
  }, 240_000)

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("GUARD: turning the flag on after a DRAFT quotation no longer lets an unwatermarked agreement follow it", async () => {
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetFinanceLegalWordingApproved: true } })
    signIn(fx.adminA, "LOAN_ADMIN")
    const refused = await routes().ncaAgreement(dealId)
    expect(refused.status).not.toBe(201)
    expect(JSON.stringify(await refused.json())).toMatch(/printed DRAFT/)
    expect(await database().assetDocumentIssuance.count({ where: { dealId } })).toBe(0)
  })

  it("FIXED: the refusal no longer promises a new quotation (a quotation is issued once): it says the deal is originated again", async () => {
    signIn(fx.adminA, "LOAN_ADMIN")
    const refused = await routes().ncaAgreement(dealId)
    const body = JSON.stringify(await refused.json())
    expect(body).toMatch(/originate it again/)
    expect(body).not.toMatch(/Issue a new quotation/)
    expect((await routes().ncaQuote(dealId)).status).not.toBe(201)
  })

  it("GUARD: a stale or forged fingerprint never publishes or issues through the app; the database ties the issuance to the approval's value", async () => {
    const template = await database().documentTemplate.findFirstOrThrow({ where: { tenantId: fx.tenantId, key: "af.resolution.standard" } })
    const draft = await createDraftVersion({ tenantId: fx.tenantId, userId: fx.adminA, totpVerified: true }, template.id, { content: starterContent(parseTemplateKey("af.resolution.standard")!) })
    if (!draft.ok) throw new Error(draft.error)
    // A legal approval written past the store with a fingerprint that is not the current one.
    await database().documentTemplateVersion.update({ where: { id: draft.value.id }, data: {
      approvedById: await legalApprover(database(), fx.tenantId), approvedAt: new Date(), approvalBasis: "LENDER_LEGAL",
      approvedContentSha256: draft.value.contentSha256, approvedSystemSha256: "0".repeat(64), legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE,
    } })
    expect(await publishVersion({ tenantId: fx.tenantId, userId: fx.adminA, totpVerified: true }, template.id, draft.value.id))
      .toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/protected wording .* changed/) })
    // Published past the store too: the app still refuses to issue from it.
    const previous = template.currentVersionId!
    await database().$transaction([
      database().documentTemplateVersion.update({ where: { id: previous }, data: { status: "ARCHIVED" } }),
      database().documentTemplateVersion.update({ where: { id: draft.value.id }, data: { status: "ACTIVE", activatedById: fx.adminA, activatedAt: new Date() } }),
      database().documentTemplate.update({ where: { id: template.id }, data: { currentVersionId: draft.value.id } }),
    ])
    await expect(selectIssuableTemplate(database() as never, fx.tenantId, "af.resolution.standard")).rejects.toThrow(/protected wording .* changed/)
    // The approval's fingerprint cannot be rewritten afterwards.
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: draft.value.id }, data: { approvedSystemSha256: "1".repeat(64) } }))).toMatch(/recorded once/)
  })

  it("FIXED (defence in depth): the quotation's recorded mark cannot be rewritten, so the unwatermarked agreement cannot issue", async () => {
    const row = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, entityId: dealId, action: "ASSET_NCA_QUOTE_ISSUED" } })
    const tampered = await sqlError(() => database().auditLog.update({ where: { id: row.id }, data: { newValue: { ...(row.newValue as object), draftLegalWording: false } } }))
    if (tampered === null) {
      signIn(fx.adminA, "LOAN_ADMIN")
      const issued = await routes().ncaAgreement(dealId)
      expect(issued.status, "the database accepted the rewritten audit row and the gate then issued").not.toBe(201)
    }
    expect(tampered, "the database accepted a rewrite of the quotation's audit row").not.toBeNull()
  })
})
