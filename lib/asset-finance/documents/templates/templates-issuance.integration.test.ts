/**
 * Real-Postgres proof that asset-finance documents are issued only from the
 * lender's published, approved template version and keep their provenance
 * (docs/asset-finance/evidence/lender-owned-templates/SPEC.md §4): refusals
 * without one (the legacy flag does not help), reproducible issuances,
 * database refusals of any other issuance, signing and downloads bound to the
 * bytes shown after a new publication or identity change, re-preparation,
 * a publication racing a preparation, the CPA instalment-sale variant, and a
 * demo approval's mark surviving the legacy flag.
 *
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/documents/templates/templates-issuance.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"
import { addMonthsClamped } from "../../dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { dealFixtureTenantId, dealRoutes } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { dealStartDate } from "../../deal-structure"
import { isoOfDbDate } from "../../dates"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { DRAFT_WATERMARK, SYNTHETIC_DEMO_WATERMARK } from "../pdf-layout"
import { canonicalContent, contentSha256, starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { systemFingerprint } from "./fingerprint"
import { expectReproducibleIssuances, publishStarterTemplates } from "./templates.integration-fixture"
import { draftApprovePublish, edited, legalActor, sha, sqlError, templateOf } from "./templates-it.helpers"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const ta = randomUUID().replaceAll("-", "").slice(0, 16)
const tb = randomUUID().replaceAll("-", "").slice(0, 16)
let a: SigningFixture
let b: SigningFixture
let cpaDeal = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required")
  return db
}
const tpl = (fx: SigningFixture, key: string) => templateOf(database(), fx.tenantId, key)
const asStaff = (fx: SigningFixture, userId: string, role: string) => {
  session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: fx.tenantId } }
}
const asClient = (fx: SigningFixture, clientId: string) => asStaff(fx, clientId, "CLIENT")
const startOf = async (dealId: string) => dealStartDate(isoOfDbDate((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { firstDueDate: true } })).firstDueDate))
const prepare = async (fx: SigningFixture, dealId: string) => {
  asStaff(fx, fx.officer, "CREDIT_OFFICER")
  return signingRoutes(fx.host).prepare(dealId, { plannedStartDate: await startOf(dealId) })
}
const pdfText = async (path: string) => {
  const lines = await texts(await readFile(path))
  return { lines, text: prose(lines).replace(/\s+/g, " ") }
}
const current = (dealId: string, document: "AGREEMENT" | "RESOLUTION" | "SURETYSHIP") =>
  database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId, document, supersededAt: null } })

suite.sequential("issuing asset-finance documents from lender templates (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    a = await createSigningFixture(database(), ta, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(ta) } }
    }, undefined, { templates: false })
    b = await createSigningFixture(database(), tb, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(tb) } }
    }, undefined, { templates: false })
    for (const fx of [a, b]) await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupSigningFixture(db, a ?? { tenantId: dealFixtureTenantId(ta) })
    await cleanupSigningFixture(db, b ?? { tenantId: dealFixtureTenantId(tb) })
    await db.$disconnect()
  })

  it("refuses without a published, approved template, even with the legacy wording flag on (nothing written)", async () => {
    for (const flag of [false, true]) {
      await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { assetFinanceLegalWordingApproved: flag } })
      const response = await prepare(a, a.dealId)
      expect(response.status).toBe(422)
      expect((await response.json()).error).toMatch(/template has not been adopted/)
    }
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { assetFinanceLegalWordingApproved: false } })
    expect(await database().dealSigner.count({ where: { dealId: a.dealId } })).toBe(0)
    expect(await database().assetDocumentIssuance.count({ where: { dealId: a.dealId } })).toBe(0)
  })

  it("refuses a published version whose wording breaks the rules, or whose approval predates the current protected wording (written past the store)", async () => {
    await publishStarterTemplates(database(), a.tenantId, a.adminA, a.adminB, ["af.isa", "af.suretyship", "af.resolution"])
    const res = await tpl(a, "af.resolution.standard")
    const legal = await legalActor(database(), a.tenantId)
    const forcePublish = async (version: number, contentText: string, approvedSystemSha256: string) => {
      const row = await database().documentTemplateVersion.create({ data: {
        templateId: res.id, version, bodyHtml: "", tokensUsed: [], content: contentText, contentSha256: contentSha256(contentText), createdById: a.adminA,
      } })
      await database().documentTemplateVersion.update({ where: { id: row.id }, data: {
        approvedById: legal.userId, approvedAt: new Date(), approvalBasis: "LENDER_LEGAL", approvedContentSha256: row.contentSha256,
        approvedSystemSha256, legalSignOffReference: "TEST FIXTURE ONLY",
      } })
      await database().$transaction([
        database().documentTemplateVersion.updateMany({ where: { templateId: res.id, status: "ACTIVE" }, data: { status: "ARCHIVED" } }),
        database().documentTemplateVersion.update({ where: { id: row.id }, data: { status: "ACTIVE", activatedById: a.adminA, activatedAt: new Date() } }),
        database().documentTemplate.update({ where: { id: res.id }, data: { currentVersionId: row.id } }),
      ])
    }
    const starter = starterContent(parseTemplateKey("af.resolution.standard")!)
    const current = await systemFingerprint("af.resolution.standard")
    await forcePublish(50, canonicalContent({ ...starter, additionalTerms: [{ heading: "Fee", text: "An administration fee of R 500 is payable." }] }), current)
    let response = await prepare(a, a.dealId)
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/no longer passes the template rules/)
    // Approved against protected wording CredaFlow has since changed: the approval has lapsed.
    await forcePublish(51, canonicalContent(starter), "0".repeat(64))
    response = await prepare(a, a.dealId)
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/protected wording for your Entity resolution \(All entity types\) changed after your approval/)
    expect(await database().assetDocumentIssuance.count({ where: { dealId: a.dealId } })).toBe(0)
    await draftApprovePublish(database(), a.tenantId, res.id, starter, a.adminA)
  })

  it("issues every document from the lender's published version, reproducibly, with the lender's own term and no mark for a legal approval, after its approver is deactivated", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const published = await draftApprovePublish(database(), a.tenantId, isa.id, edited("af.isa.commercial", "ALPHA"), a.adminA)
    // The approval stands once recorded: deactivating the approver does not withdraw it.
    const { approvedById } = await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: published } })
    expect((await database().user.findUniqueOrThrow({ where: { id: approvedById! } })).active).toBe(false)
    expect((await prepare(a, a.dealId)).status).toBe(200)
    expect(await expectReproducibleIssuances(database(), a.tenantId, a.dealId)).toEqual([
      "af.isa.commercial", "af.resolution.standard", "af.suretyship.commercial", "af.suretyship.commercial", "af.suretyship.commercial",
    ])
    const agreement = await current(a.dealId, "AGREEMENT")
    expect(agreement).toMatchObject({ templateVersionId: published, approvalBasis: "LENDER_LEGAL", systemSha256: await systemFingerprint("af.isa.commercial"), lenderIdentity: expect.objectContaining({ legalName: SYNTHETIC_IDENTITY.legalName }) })
    for (const signer of await database().dealSigner.findMany({ where: { dealId: a.dealId } })) {
      const issuance = await database().assetDocumentIssuance.findUniqueOrThrow({ where: { id: signer.issuanceId! } })
      expect(issuance.pdfSha256).toBe(signer.documentSha256)
    }
    const { lines, text } = await pdfText(agreement.pdfStoragePath!)
    expect(text).toContain("7.14 ALPHA site visits")
    expect(lines).not.toContain(DRAFT_WATERMARK)
    expect(lines).not.toContain(SYNTHETIC_DEMO_WATERMARK)
  })

  it("the database refuses an issuance from an unpublished version, the wrong variant, another lender, or any edit", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const issued = await current(a.dealId, "AGREEMENT")
    const { id: _id, issuedAt: _at, supersededAt: _s, ...copy } = issued
    const insert = (data: object) => database().assetDocumentIssuance.create({ data: { ...copy, lenderIdentity: copy.lenderIdentity as object, ...data } })
    const archived = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, status: "ARCHIVED" } })
    expect(await sqlError(() => insert({ templateVersionId: archived.id }))).toMatch(/issued only from its lender's published version/)
    expect(await sqlError(() => insert({ systemSha256: "3".repeat(64) }))).toMatch(/exact approved content and approval of its version/)
    const cpa = await tpl(a, "af.isa.cpa")
    const v = await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: cpa.currentVersionId! } })
    expect(await sqlError(() => insert({
      templateId: cpa.id, templateKey: "af.isa.cpa", templateVersionId: v.id, templateVersionNumber: v.version, templateContentSha256: v.contentSha256,
      approvalBasis: v.approvalBasis, approvedById: v.approvedById, approvedAt: v.approvedAt, legalSignOffReference: v.legalSignOffReference,
      systemSha256: v.approvedSystemSha256,
    }))).toMatch(/does not fit the deal's contract type, regime or CPA status/)
    const other = await database().documentTemplate.findFirst({ where: { tenantId: b.tenantId } })
    if (other) expect(await sqlError(() => insert({ templateId: other.id }))).toMatch(/Foreign key constraint|issued only from its lender's published version/)
    expect(await sqlError(() => database().assetDocumentIssuance.update({ where: { id: issued.id }, data: { pdfSha256: "2".repeat(64) } }))).toMatch(/issuance is immutable/)
    expect(await sqlError(() => database().assetDocumentIssuance.delete({ where: { id: issued.id } }))).toMatch(/issuance is never deleted/)
    const resolution = await database().dealSigner.findFirstOrThrow({ where: { dealId: a.dealId, document: "RESOLUTION" } })
    expect(await sqlError(() => database().dealSigner.update({ where: { id: resolution.id }, data: { issuanceId: issued.id } }))).toMatch(/current issuance of its own deal, document and bytes/)
  })

  it("after a new publication and an identity change, the issued agreement is still signed and downloaded exactly as shown", async () => {
    const agreement = await database().dealSigner.findFirstOrThrow({ where: { dealId: a.dealId, document: "AGREEMENT" } })
    const shown = await readFile(agreement.documentStoragePath!)
    const isa = await tpl(a, "af.isa.commercial")
    await draftApprovePublish(database(), a.tenantId, isa.id, edited("af.isa.commercial", "VERSION-NEXT"), a.adminA)
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { registeredOffice: "9 Changed Road\nNewtown\n0009", legalName: "TEST Renamed Lender (Pty) Ltd" } })
    asClient(a, a.director)
    const signed = await signingRoutes(a.host).portalSign(agreement.id, {
      signature: "TEST Director signs", documentSha256: agreement.documentSha256,
      signingOtpChallengeId: await verifiedSigningOtp(database(), {
        tenantId: a.tenantId, clientId: agreement.clientId, purpose: "DEAL_DOCUMENT", subjectId: agreement.id, documentSha256: agreement.documentSha256!,
      }),
    })
    expect(signed.status, await signed.clone().text()).toBe(200)
    const after = await database().dealSigner.findUniqueOrThrow({ where: { id: agreement.id } })
    expect(after).toMatchObject({ method: "E_SIGN", issuanceId: agreement.issuanceId, documentSha256: agreement.documentSha256 })
    // Downloads serve the retained bytes, to the signer and to staff.
    const portal = await signingRoutes(a.host).portalDocument(agreement.id)
    expect(portal.status).toBe(200)
    expect(Buffer.from(await portal.arrayBuffer()).equals(shown)).toBe(true)
    asStaff(a, a.officer, "CREDIT_OFFICER")
    const staff = await signingRoutes(a.host).staffDocument(a.dealId, agreement.id)
    expect(sha(Buffer.from(await staff.arrayBuffer()))).toBe(agreement.documentSha256)
    expect((await pdfText(agreement.documentStoragePath!)).text).not.toContain("VERSION-NEXT")
    expect(await sqlError(() => database().assetDocumentIssuance.update({ where: { id: agreement.issuanceId! }, data: { supersededAt: new Date() } })))
      .toMatch(/signed asset document issuance is never superseded/)
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { registeredOffice: SYNTHETIC_IDENTITY.registeredOffice, legalName: SYNTHETIC_IDENTITY.legalName } })
  })

  it("a publication racing a preparation: the preparation uses one whole published version or is refused, never a mix", async () => {
    await publishStarterTemplates(database(), b.tenantId, b.adminA, b.adminB, ["af.isa", "af.suretyship", "af.resolution"])
    const isa = await tpl(b, "af.isa.commercial")
    const before = (await tpl(b, "af.isa.commercial")).currentVersionId
    const [prepared, published] = await Promise.all([prepare(b, b.dealId), draftApprovePublish(database(), b.tenantId, isa.id, edited("af.isa.commercial", "RACE"), b.adminA)])
    if (prepared.status === 200) {
      const agreement = await current(b.dealId, "AGREEMENT")
      expect([before, published]).toContain(agreement.templateVersionId)
      expect(await expectReproducibleIssuances(database(), b.tenantId, b.dealId)).toHaveLength(5)
    } else {
      expect(prepared.status).toBe(422)
      expect((await prepared.json()).error).toMatch(/published while the documents were being prepared/)
      expect(await database().dealSigner.count({ where: { dealId: b.dealId } })).toBe(0)
    }
  })

  it("re-preparing an unsigned deal supersedes the old issuances (hashes kept, files deleted) and uses the version now published", async () => {
    expect((await prepare(b, b.dealId)).status).toBe(200)
    const first = await current(b.dealId, "AGREEMENT")
    const isa = await tpl(b, "af.isa.commercial")
    const next = await draftApprovePublish(database(), b.tenantId, isa.id, edited("af.isa.commercial", "BRAVO"), b.adminA)
    expect((await prepare(b, b.dealId)).status).toBe(200)
    const old = await database().assetDocumentIssuance.findUniqueOrThrow({ where: { id: first.id } })
    expect(old).toMatchObject({ pdfStoragePath: null, inputStoragePath: null, pdfSha256: first.pdfSha256, inputSha256: first.inputSha256, templateVersionId: first.templateVersionId })
    expect(old.supersededAt).not.toBeNull()
    await expect(readFile(first.pdfStoragePath!)).rejects.toThrow()
    await expect(readFile(first.inputStoragePath!)).rejects.toThrow()
    const now = await current(b.dealId, "AGREEMENT")
    expect(now.templateVersionId).toBe(next)
    const { text } = await pdfText(now.pdfStoragePath!)
    expect(text).toContain("BRAVO site visits")
    expect(text).not.toMatch(/ALPHA|RACE site/)
  })

  it("a signer prepared before lender templates is neither e-signed nor wet-ink confirmed; no signer is created without an issuance", async () => {
    const row = await database().dealSigner.findFirstOrThrow({ where: { dealId: b.dealId, document: "RESOLUTION" } })
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().dealSigner.update({ where: { id: row.id }, data: { issuanceId: null } }),
    ])
    expect(await sqlError(() => database().dealSigner.update({ where: { id: row.id }, data: {
      method: "E_SIGN", signedAt: new Date(), signatureData: "TEST", signatureSha256: sha(Buffer.from("TEST")),
    } }))).toMatch(/prepared before lender templates is prepared again before it is signed/)
    asStaff(b, b.officer, "CREDIT_OFFICER")
    const scan = await signingRoutes(b.host).wetInk(b.dealId, row.id, "SIGNED_RESOLUTION")
    expect(scan.status).toBe(409)
    expect(await sqlError(() => database().dealSigner.create({ data: {
      tenantId: b.tenantId, dealId: b.dealId, clientId: b.suretyA, role: "SURETY", document: "AGREEMENT",
      documentSha256: row.documentSha256, documentStoragePath: row.documentStoragePath,
    } }))).toMatch(/deal signer binds the issuance of its document/)
    // Restore the binding by preparing again.
    expect((await prepare(b, b.dealId)).status).toBe(200)
  })

  it("a CPA instalment sale is issued from the lender's CPA variant with its protected s49 notice", async () => {
    const routes = dealRoutes(b.host)
    // A small company: evidenced turnover of R1.5m is outside the NCA (juristic, at least R1m) and inside the CPA (under R2m).
    const small = await database().businessEntity.create({ data: {
      tenantId: b.tenantId, type: "COMPANY", legalName: "TEST Small Works (Pty) Ltd", registrationNumber: `2099/${tb.slice(0, 6)}/03`,
      addressLine1: "11 Synthetic Yard", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
      annualTurnover: 150_000_000, financialYearEnd: new Date("2026-02-28T00:00:00Z"), financialsEvidenceIds: [`afs-small-${tb}`],
    } })
    await database().entityRelationship.create({ data: { tenantId: b.tenantId, entityId: small.id, clientId: b.director, role: "DIRECTOR" } })
    asStaff(b, b.officer, "CREDIT_OFFICER")
    const created = await routes.create({
      assetId: b.assets[1], depositCents: 17_250_000, balloonCents: 20_000_000, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
      preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100", entityId: small.id, supplierId: b.supplier, productId: b.product,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    cpaDeal = ((await created.json()) as { id: string }).id
    expect((await routes.submit(cpaDeal)).status).toBe(200)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: cpaDeal } })
    const override = await database().ncaRegimeOverride.findFirst({ where: { applicationId: deal.applicationId, status: "PENDING" } })
    if (override) {
      asStaff(b, b.adminB, "LOAN_ADMIN")
      expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
      asStaff(b, b.officer, "CREDIT_OFFICER")
    }
    // A small juristic purchaser (turnover and assets under the CPA threshold): the CPA applies.
    expect((await routes.financials(cpaDeal, {
      periodEnd: "2026-02-28", turnoverCents: 150_000_000, ebitdaCents: 50_000_000, totalAssetsCents: 150_000_000,
      totalLiabilitiesCents: 20_000_000, existingDebtServiceCents: 1_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    asStaff(b, b.adminA, "LOAN_ADMIN")
    const decided = await routes.decide(cpaDeal, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })
    expect(decided.status, await decided.clone().text()).toBe(200)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: cpaDeal } })).isaCpaApplies).toBe(true)
    expect((await prepare(b, cpaDeal)).status).toBe(200)
    expect(await expectReproducibleIssuances(database(), b.tenantId, cpaDeal)).toContain("af.isa.cpa")
    const { text } = await pdfText((await current(cpaDeal, "AGREEMENT")).pdfStoragePath!)
    expect(text).toContain("NOTICE UNDER SECTION 49")
    expect(text).not.toContain("BRAVO site visits") // the commercial variant's wording never reaches the CPA variant
  })

  it("a demo lender's documents keep the synthetic demo mark even with the legacy wording flag on", async () => {
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: true, assetFinanceLegalWordingApproved: true } })
    for (const key of ["af.isa.cpa", "af.suretyship.commercial", "af.resolution.standard"]) {
      const template = await tpl(b, key)
      await draftApprovePublish(database(), b.tenantId, template.id, starterContent(parseTemplateKey(key)!), b.adminA, b.adminB)
    }
    expect((await prepare(b, cpaDeal)).status).toBe(200)
    const agreement = await current(cpaDeal, "AGREEMENT")
    expect(agreement.approvalBasis).toBe("SYNTHETIC_DEMO")
    const { lines } = await pdfText(agreement.pdfStoragePath!)
    expect(lines).toContain(SYNTHETIC_DEMO_WATERMARK)
    expect(lines).not.toContain(DRAFT_WATERMARK)
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: false, assetFinanceLegalWordingApproved: false } })
  })
})
