/**
 * Real-Postgres proof of lender-owned asset-finance templates
 * (docs/asset-finance/evidence/lender-owned-templates/SPEC.md): the database
 * rules on versions, approvals and publication; tenant isolation and
 * concurrency of the real store; issuance only from the lender's published,
 * approved version; and provenance that keeps a signer on the bytes and
 * version they were shown after a new publication or an identity change.
 *
 * Only the session is stubbed. Routes, store, renderers, storage, triggers,
 * CHECKs and the partial unique index are real.
 *
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/documents/templates/templates.integration.test.ts
 */
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { dealStartDate } from "../../deal-structure"
import { isoOfDbDate } from "../../dates"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"
import { renderDealDocument } from "../render"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { canonicalContent, contentSha256, starterContent, type AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"
import { pinnedIssuance, readIssuanceInput } from "./issuance"
import { adoptStarter, approveVersion, createDraftVersion, publishVersion, type TemplateActor } from "./store"
import { FIXTURE_SIGN_OFF_REFERENCE, publishStarterTemplates } from "./templates.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string; totpVerified?: boolean } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const ta = randomUUID().replaceAll("-", "").slice(0, 16)
const tb = randomUUID().replaceAll("-", "").slice(0, 16)
let a: SigningFixture
let b: SigningFixture
let plannedStart = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required")
  return db
}
/** The suite's client where a module expects the app's (extended) one. */
const appDb = () => database() as unknown as typeof import("@/lib/prisma").prisma
const actor = (fx: SigningFixture, userId: string, totpVerified = true): TemplateActor => ({ tenantId: fx.tenantId, userId, totpVerified })
const sqlError = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error("expected the database to refuse")
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const templateOf = (fx: SigningFixture, key: string) => database().documentTemplate.findFirstOrThrow({ where: { tenantId: fx.tenantId, key } })
const latest = (templateId: string) => database().documentTemplateVersion.findFirstOrThrow({ where: { templateId }, orderBy: { version: "desc" } })
const edited = (key: string, marker: string): AssetTemplateContent => ({
  ...starterContent(parseTemplateKey(key)!),
  additionalTerms: [{ heading: `${marker} site visits`, text: `${marker}: {{lender.legalName}} may inspect the goods on reasonable notice.` }],
})
const signIn = (fx: SigningFixture, userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: fx.tenantId } }
}

suite.sequential("lender-owned asset-finance templates (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    a = await createSigningFixture(database(), ta, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(ta) } }
    }, undefined, { templates: false })
    b = await createSigningFixture(database(), tb, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(tb) } }
    }, undefined, { templates: false })
    for (const fx of [a, b]) await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: a.dealId }, select: { firstDueDate: true } })
    plannedStart = dealStartDate(isoOfDbDate(deal.firstDueDate))
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupSigningFixture(db, a ?? { tenantId: dealFixtureTenantId(ta) })
    await cleanupSigningFixture(db, b ?? { tenantId: dealFixtureTenantId(tb) })
    await db.$disconnect()
  })

  it("refuses to prepare a deal's documents before the lender has a published, approved template (nothing written)", async () => {
    signIn(a, a.officer, "CREDIT_OFFICER")
    const response = await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: plannedStart })
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/template has not been adopted/)
    expect(await database().dealSigner.count({ where: { dealId: a.dealId } })).toBe(0)
    expect(await database().assetDocumentIssuance.count({ where: { dealId: a.dealId } })).toBe(0)
  })

  it("the legacy wording flag neither approves wording nor lets a document issue", async () => {
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { assetFinanceLegalWordingApproved: true } })
    signIn(a, a.officer, "CREDIT_OFFICER")
    const response = await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: plannedStart })
    expect(response.status).toBe(422)
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { assetFinanceLegalWordingApproved: false } })
  })

  it("adoption is per lender, idempotent under concurrency, and never copies another lender's wording", async () => {
    const results = await Promise.all([adoptStarter(actor(a, a.adminA), "af.isa"), adoptStarter(actor(a, a.adminA), "af.isa")])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await database().documentTemplate.count({ where: { tenantId: a.tenantId, kind: "ASSET_FINANCE" } })).toBe(2)
    expect(await database().documentTemplate.count({ where: { tenantId: b.tenantId, kind: "ASSET_FINANCE" } })).toBe(0)
    const isa = await templateOf(a, "af.isa.commercial")
    expect(await database().documentTemplateVersion.count({ where: { templateId: isa.id } })).toBe(1)
    // An edit, then adopting again: the lender's wording is untouched.
    const draft = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "ALPHA") })
    expect(draft.ok).toBe(true)
    const again = await adoptStarter(actor(a, a.adminA), "af.isa")
    expect(again).toEqual({ ok: true, value: { created: [], existing: ["af.isa.commercial", "af.isa.cpa"] } })
    expect((await latest(isa.id)).content).toBe(canonicalContent(edited("af.isa.commercial", "ALPHA")))
  })

  it("the database keeps lender wording immutable, hashed, and shaped", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const v = await latest(isa.id)
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v.id }, data: { content: canonicalContent(starterContent(parseTemplateKey("af.isa.commercial")!)) } })))
      .toMatch(/immutable/)
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: {
      templateId: isa.id, version: 99, bodyHtml: "", tokensUsed: [], content: v.content, contentSha256: "0".repeat(64), createdById: a.adminA,
    } }))).toMatch(/contentSha256 is the SHA-256/)
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: {
      templateId: isa.id, version: 99, bodyHtml: "", tokensUsed: [], content: v.content, contentSha256: v.contentSha256, createdById: a.adminA, status: "ACTIVE",
    } }))).toMatch(/created as an unapproved draft/)
    expect(await sqlError(() => database().documentTemplateVersion.delete({ where: { id: v.id } }))).toMatch(/never deleted/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { key: "af.isa.cpa" } }))).toMatch(/fixed|asset_finance_shape|Unique/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { requiresApproval: false } }))).toMatch(/asset_finance_shape/)
    // Another lender's user cannot author this lender's version.
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: {
      templateId: isa.id, version: 99, bodyHtml: "", tokensUsed: [], content: v.content, contentSha256: v.contentSha256, createdById: b.adminA,
    } }))).toMatch(/active user of its lender/)
  })

  it("approval binds the exact content, is never the author's, needs TOTP, and is refused when stale or repeated", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const v = await latest(isa.id)
    expect(await approveVersion(actor(a, a.adminA), isa.id, v.id, { contentSha256: v.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }))
      .toMatchObject({ ok: false, status: 409, error: "Cannot approve your own draft" })
    expect(await approveVersion(actor(a, a.adminB, false), isa.id, v.id, { contentSha256: v.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }))
      .toMatchObject({ ok: false, status: 403 })
    const older = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, version: 1 } })
    expect(await approveVersion(actor(a, a.adminB), isa.id, v.id, { contentSha256: older.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/changed since you previewed/) })
    expect(await approveVersion(actor(a, a.adminB), isa.id, v.id, { contentSha256: v.contentSha256, attestation: false, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }))
      .toMatchObject({ ok: false, status: 422 })
    expect(await approveVersion(actor(a, a.adminB), isa.id, v.id, { contentSha256: v.contentSha256, attestation: true, legalSignOffReference: "x" }))
      .toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/legal team's written sign-off/) })
    // Another lender cannot even find it.
    expect(await approveVersion(actor(b, b.adminB), isa.id, v.id, { contentSha256: v.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }))
      .toMatchObject({ ok: false, status: 404 })
    // Database: the author, a wrong hash, a demo basis on a real lender.
    const raw = (data: object) => database().documentTemplateVersion.update({ where: { id: v.id }, data })
    const base = { approvedAt: new Date(), approvedContentSha256: v.contentSha256, approvalBasis: "LENDER_LEGAL" as const, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }
    expect(await sqlError(() => raw({ ...base, approvedById: a.adminA }))).toMatch(/author .* cannot approve/)
    expect(await sqlError(() => raw({ ...base, approvedById: a.adminB, approvedContentSha256: "1".repeat(64) }))).toMatch(/approval_shape|exact content hash/)
    expect(await sqlError(() => raw({ ...base, approvedById: a.adminB, approvalBasis: "SYNTHETIC_DEMO", legalSignOffReference: null }))).toMatch(/demo lender/)
    expect(await sqlError(() => raw({ ...base, approvedById: b.adminB }))).toMatch(/approver is an active user/)
    // Two approvers at once: exactly one approval is recorded.
    const both = await Promise.all([a.adminB, a.officer].map((u) => approveVersion(actor(a, u), isa.id, v.id, {
      contentSha256: v.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE,
    })))
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    const approved = await latest(isa.id)
    expect(approved.approvalBasis).toBe("LENDER_LEGAL")
    expect(approved.approvedContentSha256).toBe(approved.contentSha256)
    expect(await sqlError(() => raw({ approvedById: a.adminA }))).toMatch(/recorded once/)
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "DOCUMENT_TEMPLATE_VERSION_APPROVED", entityId: v.id } })
    expect(audit.newValue).toMatchObject({ approvedContentSha256: v.contentSha256, approvalBasis: "LENDER_LEGAL", attestation: true })
  })

  it("a demo lender's approval is synthetic and cannot be a legal one; a real lender's cannot be synthetic", async () => {
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: true } })
    await adoptStarter(actor(b, b.adminA), "af.resolution")
    const res = await templateOf(b, "af.resolution.standard")
    const v = await latest(res.id)
    const ok = await approveVersion(actor(b, b.adminB), res.id, v.id, { contentSha256: v.contentSha256, attestation: true, legalSignOffReference: "ignored for a demo" })
    expect(ok).toEqual({ ok: true, value: { approvalBasis: "SYNTHETIC_DEMO" } })
    const after = await latest(res.id)
    expect(after.legalSignOffReference).toBeNull()
    // Turning the demo flag off does not turn that approval into a legal one: it can no longer publish.
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: false } })
    expect(await publishVersion(actor(b, b.adminA), res.id, v.id)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/approval basis/) })
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v.id }, data: { status: "ACTIVE", activatedById: b.adminA, activatedAt: new Date() } })))
      .toMatch(/approval basis no longer matches/)
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: true } })
    expect(await publishVersion(actor(b, b.adminA), res.id, v.id)).toMatchObject({ ok: true })
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: false } })
    // Back to a real lender: only a fresh, legally approved version issues.
    await expect(import("./issuance").then((m) => m.selectIssuableTemplate(appDb(), b.tenantId, "af.resolution.standard"))).rejects.toThrow(/synthetic demo/)
    const fresh = await createDraftVersion(actor(b, b.adminA), res.id, { content: edited("af.resolution.standard", "BRAVO-RES") })
    if (!fresh.ok) throw new Error(fresh.error)
    expect(await approveVersion(actor(b, b.adminB), res.id, fresh.value.id, { contentSha256: fresh.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })).toMatchObject({ ok: true, value: { approvalBasis: "LENDER_LEGAL" } })
    expect(await publishVersion(actor(b, b.adminA), res.id, fresh.value.id)).toMatchObject({ ok: true })
  })

  it("publication: approved drafts only, never by the approver, one ACTIVE version, no republishing an archived one", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const v1 = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, version: 1 } })
    expect(await publishVersion(actor(a, a.adminA), isa.id, v1.id)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/requires approval/) })
    const v2 = await latest(isa.id)
    const approver = v2.approvedById!
    expect(await publishVersion(actor(a, approver), isa.id, v2.id)).toMatchObject({ ok: false, error: expect.stringMatching(/approver cannot also publish/) })
    expect(await publishVersion(actor(a, a.adminA, false), isa.id, v2.id)).toMatchObject({ ok: false, status: 403 })
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v1.id }, data: { status: "ACTIVE", activatedById: a.adminA, activatedAt: new Date() } })))
      .toMatch(/approved before it is published/)
    expect(await publishVersion(actor(a, a.adminA), isa.id, v2.id)).toMatchObject({ ok: true })
    expect((await templateOf(a, "af.isa.commercial")).currentVersionId).toBe(v2.id)
    // A third draft, approved and published: v2 is archived and cannot come back.
    const v3 = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "ALPHA-THREE") })
    if (!v3.ok) throw new Error(v3.error)
    expect(await approveVersion(actor(a, a.adminB), isa.id, v3.value.id, { contentSha256: v3.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })).toMatchObject({ ok: true })
    expect(await publishVersion(actor(a, a.adminA), isa.id, v3.value.id)).toMatchObject({ ok: true, value: { archived: [v2.id] } })
    expect(await publishVersion(actor(a, a.adminA), isa.id, v2.id)).toMatchObject({ ok: false, error: expect.stringMatching(/archived version is not published again/) })
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v2.id }, data: { status: "ACTIVE" } }))).toMatch(/DRAFT to ACTIVE to ARCHIVED only|one_active/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { currentVersionId: v2.id } }))).toMatch(/one ACTIVE version/)
    expect(await database().documentTemplateVersion.count({ where: { templateId: isa.id, status: "ACTIVE" } })).toBe(1)
  })

  it("two publications at once leave exactly one ACTIVE version, and the template points at it", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const drafts = []
    for (const marker of ["RACE-ONE", "RACE-TWO"]) {
      const d = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", marker) })
      if (!d.ok) throw new Error(d.error)
      expect(await approveVersion(actor(a, a.adminB), isa.id, d.value.id, { contentSha256: d.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })).toMatchObject({ ok: true })
      drafts.push(d.value.id)
    }
    const results = await Promise.all(drafts.map((id) => publishVersion(actor(a, a.adminA), isa.id, id)))
    expect(results.every((r) => r.ok)).toBe(true)
    const active = await database().documentTemplateVersion.findMany({ where: { templateId: isa.id, status: "ACTIVE" } })
    expect(active).toHaveLength(1)
    expect((await templateOf(a, "af.isa.commercial")).currentVersionId).toBe(active[0].id)
    // Two concurrent draft saves get distinct version numbers.
    const saves = await Promise.all([1, 2].map(() => createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "SAVE") })))
    const numbers = saves.map((s) => (s.ok ? s.value.version : -1))
    expect(new Set(numbers).size).toBe(2)
  })

  it("issues every document from the lender's published version, recording provenance that reproduces each PDF", async () => {
    await publishStarterTemplates(database(), a.tenantId, a.adminA, a.adminB, ["af.isa", "af.suretyship", "af.resolution"])
    signIn(a, a.officer, "CREDIT_OFFICER")
    expect((await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: plannedStart })).status).toBe(200)
    const signers = await database().dealSigner.findMany({ where: { dealId: a.dealId } })
    const issuances = await database().assetDocumentIssuance.findMany({ where: { dealId: a.dealId, supersededAt: null } })
    expect(issuances.map((i) => i.templateKey).sort()).toEqual(["af.isa.commercial", "af.resolution.standard", "af.suretyship.commercial", "af.suretyship.commercial", "af.suretyship.commercial"])
    const isa = await templateOf(a, "af.isa.commercial")
    for (const signer of signers) {
      const issuance = issuances.find((i) => i.id === signer.issuanceId)!
      expect(issuance.pdfSha256).toBe(signer.documentSha256)
      expect(sha(await readFile(issuance.pdfStoragePath!))).toBe(issuance.pdfSha256)
      expect(issuance.lenderIdentity).toMatchObject({ legalName: SYNTHETIC_IDENTITY.legalName })
      expect(issuance.approvalBasis).toBe("LENDER_LEGAL")
      // The retained input and the pinned version reproduce the exact bytes.
      const input = await readIssuanceInput(issuance.inputStoragePath!, issuance.inputSha256)
      const pinned = await pinnedIssuance(appDb(), a.tenantId, issuance.id)
      if (input.kind !== "deal" || !pinned) throw new Error("expected a deal issuance")
      expect((await renderDealDocument(input.data, input.document, input.clientId, pinned.wording)).sha256).toBe(issuance.pdfSha256)
    }
    const agreement = issuances.find((i) => i.document === "AGREEMENT")!
    expect(agreement.templateVersionId).toBe(isa.currentVersionId)
    // The agreement carries the lender's own additional term of its published version.
    const published = await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: isa.currentVersionId! } })
    expect(agreement.templateContentSha256).toBe(contentSha256(published.content!))
    expect(prose(await texts(await readFile(agreement.pdfStoragePath!))).replace(/\s+/g, " ")).toContain(`7.14 SAVE site visits`)
  })

  it("the database refuses an issuance from an unpublished version, the wrong variant, another lender, or any edit", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const issued = await database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: a.dealId, document: "AGREEMENT", supersededAt: null } })
    const { id: _id, issuedAt: _at, supersededAt: _s, ...copy } = issued
    const archived = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, status: "ARCHIVED" } })
    const insert = (data: object) => database().assetDocumentIssuance.create({ data: { ...copy, lenderIdentity: copy.lenderIdentity as object, ...data } })
    expect(await sqlError(() => insert({ templateVersionId: archived.id }))).toMatch(/published version/)
    const cpa = await templateOf(a, "af.isa.cpa")
    const cpaVersion = await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: cpa.currentVersionId! } })
    // Every other field matches the CPA version exactly: only the deal's CPA status refuses it.
    expect(await sqlError(() => insert({
      templateId: cpa.id, templateKey: "af.isa.cpa", templateVersionId: cpaVersion.id, templateVersionNumber: cpaVersion.version,
      templateContentSha256: cpaVersion.contentSha256, approvalBasis: cpaVersion.approvalBasis, approvedById: cpaVersion.approvedById,
      approvedAt: cpaVersion.approvedAt, legalSignOffReference: cpaVersion.legalSignOffReference,
    }))).toMatch(/does not fit the deal/)
    const bTemplate = await templateOf(b, "af.resolution.standard")
    expect(await sqlError(() => insert({ templateId: bTemplate.id }))).toMatch(/foreign key|published version/i)
    expect(await sqlError(() => database().assetDocumentIssuance.update({ where: { id: issued.id }, data: { pdfSha256: "2".repeat(64) } }))).toMatch(/immutable/)
    expect(await sqlError(() => database().assetDocumentIssuance.delete({ where: { id: issued.id } }))).toMatch(/never deleted/)
    // A signer row cannot point at another document's bytes.
    const signer = await database().dealSigner.findFirstOrThrow({ where: { dealId: a.dealId, document: "RESOLUTION" } })
    expect(await sqlError(() => database().dealSigner.update({ where: { id: signer.id }, data: { issuanceId: issued.id } }))).toMatch(/current issuance of its own deal, document and bytes/)
  })

  it("a new publication and a changed lender identity do not change a document already issued: it is signed as shown", async () => {
    const agreement = await database().dealSigner.findFirstOrThrow({ where: { dealId: a.dealId, document: "AGREEMENT" } })
    const shownBytes = await readFile(agreement.documentStoragePath!)
    // Publish a new version of the agreement template and change the lender's office.
    const isa = await templateOf(a, "af.isa.commercial")
    const next = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "VERSION-NEXT") })
    if (!next.ok) throw new Error(next.error)
    expect(await approveVersion(actor(a, a.adminB), isa.id, next.value.id, { contentSha256: next.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })).toMatchObject({ ok: true })
    expect(await publishVersion(actor(a, a.adminA), isa.id, next.value.id)).toMatchObject({ ok: true })
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { registeredOffice: "9 Changed Road\nNewtown\n0009" } })

    session.current = { user: { id: a.director, email: `${a.director}@templates-it.test`, role: "CLIENT", tenantId: a.tenantId } }
    const signed = await signingRoutes(a.host).portalSign(agreement.id, {
      signature: "TEST Director signs", documentSha256: agreement.documentSha256,
      signingOtpChallengeId: await verifiedSigningOtp(database(), {
        tenantId: a.tenantId, clientId: agreement.clientId, purpose: "DEAL_DOCUMENT", subjectId: agreement.id, documentSha256: agreement.documentSha256!,
      }),
    })
    expect(signed.status).toBe(200)
    const after = await database().dealSigner.findUniqueOrThrow({ where: { id: agreement.id } })
    expect(after.method).toBe("E_SIGN")
    expect(after.issuanceId).toBe(agreement.issuanceId)
    expect((await readFile(after.documentStoragePath!)).equals(shownBytes)).toBe(true)
    // A signed issuance is never superseded.
    expect(await sqlError(() => database().assetDocumentIssuance.update({ where: { id: agreement.issuanceId! }, data: { supersededAt: new Date() } }))).toMatch(/signed asset document issuance is never superseded/)
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { registeredOffice: SYNTHETIC_IDENTITY.registeredOffice } })
  })

  it("re-preparing an unsigned deal supersedes the old issuances, keeps their hashes, and uses the newly published version", async () => {
    // Lender B: nothing signed yet. Prepare, publish a new version, prepare again.
    await publishStarterTemplates(database(), b.tenantId, b.adminA, b.adminB, ["af.isa", "af.suretyship"])
    signIn(b, b.officer, "CREDIT_OFFICER")
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: b.dealId }, select: { firstDueDate: true } })
    const start = dealStartDate(isoOfDbDate(deal.firstDueDate))
    expect((await signingRoutes(b.host).prepare(b.dealId, { plannedStartDate: start })).status).toBe(200)
    const first = await database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: b.dealId, document: "AGREEMENT", supersededAt: null } })
    const isa = await templateOf(b, "af.isa.commercial")
    const next = await createDraftVersion(actor(b, b.adminA), isa.id, { content: edited("af.isa.commercial", "BRAVO") })
    if (!next.ok) throw new Error(next.error)
    expect(await approveVersion(actor(b, b.adminB), isa.id, next.value.id, { contentSha256: next.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })).toMatchObject({ ok: true })
    expect(await publishVersion(actor(b, b.adminA), isa.id, next.value.id)).toMatchObject({ ok: true })
    expect((await signingRoutes(b.host).prepare(b.dealId, { plannedStartDate: start })).status).toBe(200)
    const old = await database().assetDocumentIssuance.findUniqueOrThrow({ where: { id: first.id } })
    expect(old.supersededAt).not.toBeNull()
    expect(old.pdfStoragePath).toBeNull()
    expect(old.pdfSha256).toBe(first.pdfSha256)
    await expect(readFile(first.pdfStoragePath!)).rejects.toThrow()
    // The superseded render input (personal data) is deleted too; its hash stays.
    expect(old.inputStoragePath).toBeNull()
    expect(old.inputSha256).toBe(first.inputSha256)
    await expect(readFile(first.inputStoragePath!)).rejects.toThrow()
    const current = await database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: b.dealId, document: "AGREEMENT", supersededAt: null } })
    expect(current.templateVersionId).toBe(next.value.id)
    expect(current.pdfSha256).not.toBe(first.pdfSha256)
    // Lender A's wording never reaches lender B's documents.
    const text = prose(await texts(await readFile(current.pdfStoragePath!))).replace(/\s+/g, " ")
    expect(text).toContain("BRAVO site visits")
    expect(text).not.toContain("ALPHA")
    expect(text).not.toContain("SAVE")
  })

  it("a deal signer prepared before lender templates cannot be signed, and no new signer can be created without an issuance", async () => {
    const row = await database().dealSigner.findFirstOrThrow({ where: { dealId: b.dealId, document: "RESOLUTION" } })
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().dealSigner.update({ where: { id: row.id }, data: { issuanceId: null } }),
    ])
    expect(await sqlError(() => database().dealSigner.update({ where: { id: row.id }, data: {
      method: "E_SIGN", signedAt: new Date(), signatureData: "TEST", signatureSha256: sha(Buffer.from("TEST")),
    } }))).toMatch(/prepared before lender templates|prepared again/)
    expect(await sqlError(() => database().dealSigner.create({ data: {
      tenantId: b.tenantId, dealId: b.dealId, clientId: b.suretyA, role: "SURETY", document: "AGREEMENT",
      documentSha256: row.documentSha256, documentStoragePath: row.documentStoragePath,
    } }))).toMatch(/binds the issuance|role_document/)
  })
})
